// Generates a short, pre-edit natural-language summary of a file for
// `opencode run --summary`. Runs a single direct provider call (not the full
// session/agent turn machinery) so it stays cheap and easy to fail open on.
import type { Provider } from "@/provider/provider"
import { Effect, Stream } from "effect"
import { streamText } from "ai"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { SessionAuxiliaryUsage } from "@/session/auxiliary-usage"
import type { SessionID } from "@/session/schema"

const MAX_CONTENT_CHARS = 20_000

// `model` is the session's active model. It is preferred over the configured
// default so the summary uses a provider/credential the user actually chose for
// this run, rather than whichever provider happens to be the global default.
export const summarizeFile = (input: {
  provider: Provider.Interface
  model?: Provider.Model
  sessionID: SessionID
  abort: AbortSignal
  path: string
  content: string
}) =>
  Effect.gen(function* () {
    if (input.abort.aborted) return yield* Effect.interrupt
    const model =
      input.model ??
      (yield* input.provider
        .defaultModel()
        .pipe(Effect.flatMap((selected) => input.provider.getModel(selected.providerID, selected.modelID))))
    const language = yield* input.provider.getLanguage(model)
    const content =
      input.content.length > MAX_CONTENT_CHARS
        ? input.content.slice(0, MAX_CONTENT_CHARS) + "\n...(truncated)"
        : input.content

    const text = yield* Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        SessionAuxiliaryUsage.text(
          { sessionID: input.sessionID, model, purpose: "edit-summary" },
          Stream.unwrap(
            Effect.sync(() => {
              // Keep provider execution lazy: the collector must persist pending usage first.
              const result = streamText({
                model: language,
                abortSignal: AbortSignal.any([input.abort, controller.signal]),
                includeRawChunks: model.providerID.includes("github-copilot"),
                temperature: 0.3,
                messages: [
                  {
                    role: "user",
                    content: `Write a concise 3-6 sentence plain-language summary of this file's purpose and structure.\n\nFile: ${input.path}\n\n${content}`,
                  },
                ],
              })
              const state = LLMAISDK.adapterState()
              return Stream.fromAsyncIterable(result.fullStream, (error) => error).pipe(
                Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                Stream.flatMap((events) => Stream.fromIterable(events)),
              )
            }),
          ),
        ),
      (controller) => Effect.sync(() => controller.abort()),
    )
    if (input.abort.aborted) return yield* Effect.interrupt
    return text.trim()
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.raceFirst(
      Effect.callback<never>((resume) => {
        const cancel = () => resume(Effect.interrupt)
        if (input.abort.aborted) return cancel()
        input.abort.addEventListener("abort", cancel, { once: true })
        return Effect.sync(() => input.abort.removeEventListener("abort", cancel))
      }),
    ),
  )

export * as EditSummary from "./edit-summary"
