# Tja

## A therapeutic journaling assistant

_note: not a real therapist_

This is a service for the [signal](https://signal.org/sv/) messaging service that makes the "note to self" feature start to behave as your own personal therapist, that will nag you to write a journal entry at the end of each day.

## Background and motivation

I wanted to get better at keeping a diary, but always think its difficult to get started and keep it up as a habit. So I started creating a Signal-bot that would remind me to write in my journal and that would offer writing prompts and advice. As my reasoning for keeping a journal is for self-therapeutic and mental health reasons I found and included a ChatGPT personality based on therapeutic analysis.

## Results

The results are working for my personal use, might not be the best documented repository I have released.

## Install and configure

1. Rename `env.example` to `.env` and enter the correct values for each field, only the API key for ChatGPT is neccessary for running the test command - for example if you don't want to use this as an signal agent.

2. Dependencies

 You'll need to install `signal-cli` on the same device and link or register an account, that accounts phone number must be added to the .env file.

3. Install dependencies

   `npm ci`

### Test the service in the terminal

   `node index.mjs test`

This does not require you to set up signal-cli, but you do need a OpenAI API Key.

### Run it as a signal service

   `node index.mjs start`

---

Enjoy ❤️
Lyret
