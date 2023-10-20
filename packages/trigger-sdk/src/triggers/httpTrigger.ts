import { EventFilter, TriggerMetadata, deepMergeFilters } from "@trigger.dev/core";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, EventSpecificationExample, SchemaParser, Trigger } from "../types";
import { formatSchemaErrors } from "../utils/formatSchemaErrors";
import { ParsedPayloadSchemaError } from "../errors";

type Options<TEventSpecification extends EventSpecification<any>> = {
  event: TEventSpecification;
  name?: string | string[];
  source?: string;
  filter?: EventFilter;
};

export class HttpTrigger<TEventSpecification extends EventSpecification<any>>
  implements Trigger<TEventSpecification>
{
  #options: Options<TEventSpecification>;

  constructor(options: Options<TEventSpecification>) {
    this.#options = options;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "modular",
      id: "",
    };
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {}

  get preprocessRuns() {
    return false;
  }
}

/** Configuration options for an EventTrigger */
export type HttpTriggerOptions<TEvent> = {
  /** The name of the event you are subscribing to. Must be an exact match (case sensitive). To trigger on multiple possible events, pass in an array of event names */
  name: string | string[];
  /** A [Zod](https://trigger.dev/docs/documentation/guides/zod) schema that defines the shape of the event payload.
   * The default is `z.any()` which is `any`.
   * */
  schema?: SchemaParser<TEvent>;
  /** You can use this to filter events based on the source. */
  source?: string;
  /** Used to filter which events trigger the Job
   * @example
   * filter:
   * ```ts
   * {
   *    name: ["John", "Jane"],
   *    age: [18, 21]
   * }
   * ```
   *
   * This filter would match against an event with the following data:
   * ```json
   * {
   *    "name": "Jane",
   *    "age": 18,
   *    "location": "San Francisco"
   * }
   * ```
   */
  filter?: EventFilter;

  examples?: EventSpecificationExample[];
};

/** `eventTrigger()` is set as a [Job's trigger](https://trigger.dev/docs/sdk/job) to subscribe to an event a Job from [a sent event](https://trigger.dev/docs/sdk/triggerclient/instancemethods/sendevent)
 * @param options options for the EventTrigger
 */
export function httpTrigger<TEvent extends any = any>(
  options: HttpTriggerOptions<TEvent>
): Trigger<EventSpecification<TEvent>> {
  return new HttpTrigger({
    name: options.name,
    filter: options.filter,
    event: {
      name: options.name,
      title: "Event",
      source: options.source ?? "trigger.dev",
      icon: "custom-event",
      examples: options.examples,
      parsePayload: (rawPayload: any) => {
        if (options.schema) {
          const results = options.schema.safeParse(rawPayload);

          if (!results.success) {
            throw new ParsedPayloadSchemaError(formatSchemaErrors(results.error.issues));
          }

          return results.data;
        }

        return rawPayload as any;
      },
    },
  });
}