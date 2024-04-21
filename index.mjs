import OpenAI from "openai";
import FlatCache from "flat-cache";
import { DateTime, Interval } from "luxon";
import * as ReadLine from "node:readline/promises";
import * as Fs from "node:fs/promises";
import { scheduleJob } from "node-schedule";
import { config } from "dotenv";
import { program } from "commander";
import { execa } from "execa";
import { stdin as input, stdout as output } from "node:process";
import {
	GPT_EMOJI_REACTION_SYSEM_MESSAGE,
	GPT_THERAPIST_SYSEM_MESSAGE,
} from "./systems.mjs";

// SETUP ---------------

// Load .env definitions
config();

// GLOBAL VARIABLES ---------------

/** Interval at which to read and respond to messages */
const READ_CRON_INTERVAL = "0-59 * * * *"; // Every minute

/** Interval at which to seek contact with the patient */
const CONTACT_CRON_INTERVAL = "0 16 * * *"; // At 16.00

/** API Key to ChatGPT */
const GPT_API_KEY = process.env.GPT_API_KEY;

/** Phone number to use in Signal for messages */
const PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER;

/** The name of the user */
const USER_NAME = process.env.USER_NAME;

/** Authenticated connection to the Chat GPT API */
const ChatGPTConnection = new OpenAI({
	apiKey: GPT_API_KEY,
});

/** Cached session information */
const CACHE = FlatCache.load("tja");

/** Current state of any ongoing session */
const SESSION = {
	/** Id for serializing the session  */
	ID: "",
	/** Current or initial topic of discussion, i.e. question from the assistant */
	TOPIC: "",
	/** The journal entry for the current session */
	JOURNAL: "",
	/** Conversation history */
	CONVERSATION: [],
	/** Time the session started */
	STARTED: undefined,
	/** Time the session ended, or the current conversation time if still active */
	ENDED: undefined,
	/** Duration of the session in minutes */
	DURATION: 0,
	/** Indicates that the session is active, otherwise it has ended */
	ACTIVE: false,
	/** Persistent patient profile */
	PATIENT_PROFILE: CACHE.getKey("PATIENT_PROFILE") || [],
};

/** Indicates that we are running a test in the terminal, otherwise uses Signal */
let IS_TERMINAL = false;

// FUNCTIONS ---------------

async function getTheraputicResponseFromLLM(msg, retries = 3) {
	try {
		console.log("[LLM RESPONSE]", `Getting a response from the LLM...`);

		// Calculate the current duration of the session
		SESSION.ENDED = DateTime.now();
		SESSION.DURATION = Interval.fromDateTimes(
			SESSION.STARTED,
			SESSION.ENDED
		).length("minutes");

		// Update the conversation
		SESSION.CONVERSATION.push({
			role: "assistant",
			content: SESSION.TOPIC,
		});
		
		SESSION.CONVERSATION.push({
			role: "user",
			content: msg.text,
		});

		// Get the response from the LLM
		const response = await ChatGPTConnection.chat.completions.create({
			model: "gpt-3.5-turbo-0125",
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content: GPT_THERAPIST_SYSEM_MESSAGE({
						name: USER_NAME,
						currentDuration: SESSION.DURATION,
						currentTime: SESSION.ENDED.toLocaleString(
							DateTime.DATETIME_SHORT
						)
					}),
				},
				...SESSION.CONVERSATION
			],
		});

		// Try to parse the answer as json
		try {
			console.log(response.choices[0].message.content);
			const json = JSON.parse(response.choices[0].message.content);

			// Update session variables and the patient profile
			SESSION.JOURNAL = json["JournalEntry"];
			console.log(SESSION.PATIENT_PROFILE)
			SESSION.PATIENT_PROFILE = [
				...(SESSION.PATIENT_PROFILE || []),
				...(json["PatientProfile"] || []),
			];

			// Update the cache
			CACHE.setKey("PATIENT_PROFILE", SESSION.PATIENT_PROFILE);
			CACHE.setKey("SESSION" + SESSION.ID, SESSION);
			
			// Write to file
			await Fs.writeFile(`./history/id-${SESSION.ID}-${SESSION.ENDED.toMillis()}`, JSON.stringify({ RESPONSE: json, SESSION }, null, 4),{ encoding: 'utf8'})

			// Figure out the next question and whenever or not to end the session and
			// update the topic being discussed
			SESSION.TOPIC =
				json["EndOfSessionResponse"] ||
				(json["NextSuggestions"] && json["NextSuggestions"][1]) ||
				(json["NextSuggestions"] && json["NextSuggestions"][0]) ||
				(json["NextSuggestion"] && json["NextSuggestion"][0]) ||
				SESSION.TOPIC;
			SESSION.ACTIVE = !json["EndOfSessionResponse"];

			if (IS_TERMINAL) {
				console.log({ RESPONSE: json, SESSION });
			}
			return [SESSION.TOPIC, null];
		} catch (err) {
			// Try again until valid json is returned
			console.error(err);
			if (!retries > 0) {
				throw new Error(
					"Failed to parse json within the allowed number of retries"
				);
			}
			return getTheraputicResponseFromLLM(msg, retries - 1);
		}
	} catch (err) {
		console.error("[LLM RESPONSE]", String(err));
		return [null, err];
	}
}

async function getReactionFromLLM(msg) {
	try {
		if (IS_TERMINAL) {
			return [null, null];
		}
		console.log("[LLM REACTION]", `Getting a response from the LLM...`);
		const answer = await ChatGPTConnection.chat.completions.create({
			model: "gpt-3.5-turbo-0125",
			messages: [
				{
					role: "system",
					content: GPT_EMOJI_REACTION_SYSEM_MESSAGE(),
				},
			],
		});
		const text = answer.choices[0].message.content;
		if (text == "0") {
			return [null, null];
		}
		return [text, null];
	} catch (err) {
		console.error("[LLM REACTION]", String(err));
		return [null, err];
	}
}

async function sendMessageReaction(msg, emoji) {
	console.log(`[REACT TO MESSAGE] Reacting to "${msg.text}" with ${emoji}`);
	try {
		await execa("signal-cli", [
			"-o",
			"json",
			"-u",
			PHONE_NUMBER,
			"sendReaction",
			PHONE_NUMBER,
			"-e",
			emoji,
			"-t",
			msg.timestamp,
			"-a",
			PHONE_NUMBER,
		]);
		return [null, null];
	} catch (err) {
		console.error("[REACT TO MESSAGE]", String(err));
		return [null, err];
	}
}

async function sendMessage(text) {
	if (IS_TERMINAL) {
		console.log(text);
		return [null, null];
	}
	try {
		console.log(`[SEND MESSAGE] Sending a Signal message: ${text}`);
		await execa("signal-cli", [
			"-o",
			"json",
			"-u",
			PHONE_NUMBER,
			"send",
			"-m",
			text,
			PHONE_NUMBER,
			"--notify-self",
		]);
		return [null, null];
	} catch (err) {
		console.error("[SEND MESSAGE]", String(err));
		return [null, err];
	}
}

async function readIncommingMessages() {
	try {
		if (IS_TERMINAL) {
			console.log("\n");
			let rl = ReadLine.createInterface({ input, output });
			const text = await rl.question("> ");
			const messages = [
				{
					text,
					timestamp: new Date().getTime(),
				},
			];
			rl.close();
			return [messages, null];
		}
		const { stdout } = await execa("signal-cli", [
			"-o",
			"json",
			"-u",
			PHONE_NUMBER,
			"receive",
			"--ignore-stories",
		]);

		const messages = stdout
			.split("\n")
			.filter((msg) => msg.length)
			.map((msg) => JSON.parse(msg))
			.filter((msg) => msg.envelope.sourceNumber == PHONE_NUMBER)
			.filter((msg) => !!msg.envelope.syncMessage?.sentMessage)
			.map((msg) => msg.envelope.syncMessage)
			.filter((smsg) => smsg.sentMessage.destinationNumber == PHONE_NUMBER)
			.map((smsg) => ({
				timestamp: smsg.sentMessage.timestamp,
				text: smsg.sentMessage.message,
			}));

		console.log(`[READ MESSAGES] Found ${messages.length} new messages`);
		return [messages, null];
	} catch (err) {
		console.error("[READ MESSAGES]", String(err));
		return [[], err];
	}
}

/** Creates a new session if the previous one has ended or if the time since messages was sent last time is over 8 hours */
async function createSession() {
	try {
		if (!SESSION.ACTIVE || Interval.fromDateTimes(
				SESSION.ENDED,
				DateTime.now()
			).length("hours") > 8) {
				console.log("[CREATE SESSION]", `Initializing a new session...`);
				SESSION.ID = DateTime.now().toMillis();
				SESSION.STARTED = DateTime.now();
				SESSION.ENDED = DateTime.now();
				SESSION.DURATION = 0;
				SESSION.CONVERSATION = [];
				SESSION.JOURNAL = "";
				SESSION.TOPIC = "Tja! Hur var din dag idag?";
				SESSION.ACTIVE = true;
				return [true, null];
			}
			// Keep the current session active
			else {
				return [false, null];
			}
	} catch (err) {
		console.error("[SEEK CONTACT]", String(err));
		return [null, err];
	}
}
	
async function seekContact(waitTime = 0) {
	try {
		if (!waitTime) {
			console.log("[SEEK CONTACT]", `Randomizing a wait interval`);
			const hours = Math.round(Math.random() * 2); // Between 0-2 hours
			const minutes = Math.round(Math.random() * 60); // Between 0-60 minutes
			console.log(
				"[SEEK CONTACT]",
				`Waiting for ${hours} h ${minutes} minutes`
			);
			waitTime = (hours * 60 + minutes) * 60 * 1000;
		}

		return await new Promise((resolve) => {
			setTimeout(() => {
				createSession().then(([sessionIsNew]) => {
					if (sessionIsNew) {
						sendMessage(SESSION.TOPIC);
					}
					resolve([null, null]);
				});
			}, waitTime);
		});
	} catch (err) {
		console.error("[SEEK CONTACT]", String(err));
		return [null, err];
	}
}

async function respondToMessages() {
	try {
			console.log(`[RESPOND TO MESSAGES] Reading incomming messages...`);
			const [messages] = await readIncommingMessages();
			if (messages.length) {
				await createSession();
			}
			for (const msg of messages) {
				getReactionFromLLM(msg).then(([emoji]) => {
					if (emoji) {
						sendMessageReaction(msg, emoji);
					}
				});
				const [response] = await getTheraputicResponseFromLLM(msg);
				if (response) {
					sendMessage(response);
				}
			}
		} 
		catch (err) {
				console.error("[RESPOND TO MESSAGS]", String(err));
				return [null, err];
			}
}

// PROGAM DEFINITION ---------------

// Set general program description
program
	.name("Therapeutic Journaling Assistant")
	.description(
		"Signal Service Integrating with the 'note-to-self' feature to allow scheduled journal entries with therapeutic advice."
	);

// Add test session command
program
	.command("test")
	.description("Perform a single session conversation in the terminal")
	.action(async () => {
		IS_TERMINAL = true;
		await seekContact(100);
		while (SESSION.ACTIVE) {
			await respondToMessages();
		}
		console.log(`[PROGRAM] Completed test execution`);
	});

// Add start session service command
program
	.command("start", { isDefault: true })
	.description(
		"Run the service and seek contact and read incomming messages on an interval"
	)
	.action(async () => {
		scheduleJob(READ_CRON_INTERVAL, respondToMessages);
		scheduleJob(CONTACT_CRON_INTERVAL, seekContact);
		console.log(
			`[PROGRAM] The service is now running and will seek contact and read messages on an interval`
		);
	});

// PROGRAM EXECUTION ---------------

program.program.parse();
