import { AssistantIntent } from "../types";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://nepali-assistant.onrender.com";

// Sends the Nepali transcript plus lightweight context (contact names only —
// never phone numbers, never medicine history) to the backend, which prompts
// Claude to return ONE of the structured intents below. Keeping the LLM
// scoped to a fixed set of intents (rather than "do anything") is a
// deliberate safety choice: it's far more reliable for elderly users and much
// easier to test than an open-ended agent.
export const llmService = {
  async interpret(
    transcript: string,
    knownContactNames: string[]
  ): Promise<AssistantIntent> {
    const res = await fetch(`${BACKEND_URL}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, knownContactNames }),
    });

    if (!res.ok) {
      return { type: "unclear", transcript };
    }

    return (await res.json()) as AssistantIntent;
  },
};
