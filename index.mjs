import { ChatGPTAPI } from "chatgpt";
import { scheduleJob } from "node-schedule";
import { config } from "dotenv";
import { program } from "commander";
import { execa } from "execa";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
	GPT_JOURNAL_SYSEM_MESSAGE,
	GPT_THERAPIST_SYSEM_MESSAGE,
} from "./systems.mjs";

// SETUP ---------------

// Load .env definitions
config();

// GLOBAL VARIABLES ---------------

/** Interval at which to read and respond to messages */
const CRON_INTERVAL = "0-59 * * * *";

/** Phone number to use in Signal for messages */
const PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER;

/** API Key to ChatGPT */
const GPT_API_KEY = process.env.GPT_API_KEY;

/** Authenticated connection to the Chat GPT API */
const ChatGPTConnection = new ChatGPTAPI({
	apiKey: GPT_API_KEY,
});

/** Id for keeping track of an ongoing conversation */
let GPT_PARENT_MESSAGE_ID = undefined;

// FUNCTIONS ---------------

async function getResponseFromLLM(msg) {
	console.log("[LLM RESPONSE]", `Getting a response from the LLM...`);
	try {
    const tokens = {
      
    };
		const answer = await ChatGPTConnection.sendMessage(msg.text, {
			parentMessageId: GPT_PARENT_MESSAGE_ID,
			systemMessage: GPT_JOURNAL_SYSEM_MESSAGE(tokens),
		});
		const { text, parentMessageId } = answer;

		// Update the parent id for keepin track of the conversation
		GPT_PARENT_MESSAGE_ID = parentMessageId;

		return [text, null];
	} catch (err) {
		console.error("[LLM RESPONSE]", String(err));
		return [null, err];
	}
}

async function getReactionFromLLM(msg) {
	console.log("[LLM REACTION]", `Getting a response from the LLM...`);
	try {
		const answer = await ChatGPTConnection.sendMessage(msg.text, {
			systemMessage: `Read the message and determine what emoji to react with in a messaging application. Its ok if no emoji seems suitable. If no emoji seems suitable, respond with "0". Otherwise respond only with the emoji to use for a reaction. Its important to respond only with a single emoji or the character "0" and nothing else`,
		});
		const { text } = answer;
		if (text == "0") {
			return [null, null];
		}
		console.log(answer);
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

async function sendMessage(msg) {
	console.log(`[SEND MESSAGE] Sending a Signal message: ${msg}`);
	try {
		await execa("signal-cli", [
			"-o",
			"json",
			"-u",
			PHONE_NUMBER,
			"send",
			"-m",
			msg,
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
	console.log(`[READ MESSAGES] Reading incomming messages on Signal...`);
	try {
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
		console.error("[READ MESSAGEs]", String(err));
		return [[], err];
	}
}

// PROGAM DEFINITION ---------------

async function main(text) {
	const rl = readline.createInterface({ input, output });
	while (true) {
		const text = await rl.question("> ");
		const messages = [
			{
				text,
				timestamp: new Date().getTime(),
			},
		];

		// const [messages] = await readIncommingMessages();
		for (const msg of messages) {
			// TODO: re-add
			// getReactionFromLLM(msg).then(([emoji]) => {
			//   if (emoji) {
			//     sendMessageReaction(msg, emoji);
			//   }
			// });
			const [response] = await getResponseFromLLM(msg);
			if (response) {
				// TODO: re-add await sendMessage(response);
				console.log(response);
			}
		}
	}
}

program.name("TJA").description("Therapeutic Journaling Assistant");

// Start command
program
	.command("test")
	.description("Perform a single execution of the TJA service")
	.argument("<text>", "text message to test the service with")
	.action(async (text) => {
		await main(text);
		console.log(`[PROGRAM] Completed test execution`);
	});

// Start command
program
	.command("start", { isDefault: true })
	.description("Run the TJA service and read incomming messages on an interval")
	.action(async () => {
		await main();
		scheduleJob(CRON_INTERVAL, main);
		console.log(`[PROGRAM] The service is now running on an interval`);
	});

// PROGRAM EXECUTION ---------------

program.program.parse();
