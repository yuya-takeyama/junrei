import type { AppType } from "@junrei/server";
import type { InferResponseType } from "hono/client";
import { hc } from "hono/client";

export const client = hc<AppType>("/");

/** JSON-serialized shapes as the API actually returns them (via Hono RPC inference). */
export type SessionListItem = InferResponseType<
  typeof client.api.sessions.$get
>["sessions"][number];
export type ModelMixEntry = SessionListItem["modelMix"][number];

type SessionResponse = InferResponseType<(typeof client.api.sessions)[":project"][":id"]["$get"]>;
export type SessionJson = Extract<SessionResponse, { sessionId: string }>;
export type SubagentNodeJson = SessionJson["subagents"][number];

type TimelineResponse = InferResponseType<
  (typeof client.api.sessions)[":project"][":id"]["timeline"]["$get"]
>;
export type TimelineEntry = Extract<TimelineResponse, { entries: unknown[] }>["entries"][number];
