// Generates a short, pre-edit natural-language summary of a file for
// `opencode run --summary`. Runs a single direct provider call (not the full
// session/agent turn machinery) so it stays cheap and easy to fail open on.
import type { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { streamText } from "ai"

const MAX_CONTENT_CHARS = 20_000

// `model` is the session's active model. It is preferred over the configured
// default so the summary uses a provider/credential the user actually chose for
// this run, rather than whichever provider happens to be the global default.
export const summarizeFile = (input: {
  provider: Provider.Interface
  model?: Provider.Model
  path: string
  content: string
}) =>
  Effect.gen(function* () {
    const model =
      input.model ??
      (yield* input.provider.defaultModel().pipe(
        Effect.flatMap((selected) => input.provider.getModel(selected.providerID, selected.modelID)),
      ))
    const language = yield* input.provider.getLanguage(model)
    const content =
      input.content.length > MAX_CONTENT_CHARS
        ? input.content.slice(0, MAX_CONTENT_CHARS) + "\n...(truncated)"
        : input.content

    return yield* Effect.tryPromise({
      try: async () => {
        const result = streamText({
          model: language,
          temperature: 0.3,
          messages: [
            {
              role: "user",
              content: `Write a concise 3-6 sentence plain-language summary of this file's purpose and structure.\n\nFile: ${input.path}\n\n${content}`,
            },
          ],
        })
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error
        }
        return (await result.text).trim()
      },
      catch: (error) => error,
    })
  }).pipe(Effect.timeout("10 seconds"))

export * as EditSummary from "./edit-summary"
