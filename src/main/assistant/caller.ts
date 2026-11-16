/**
 * The Assistant as a caller of Mockingbird's MCP server (messaging.ts): each turn's launch is minted as
 * `assistant-<turnId>`. Pane ids are 8 hex characters and Council's seats `collab-…`, so none can be read as one.
 * The prefix also picks, in the generated server, which tools/list it gives; only the token says who's calling.
 */
export const ASSISTANT_CALLER_PREFIX = "assistant-";

/** The request the Assistant's server sends for tools/list: not a tool name, which never holds a slash. */
export const ASSISTANT_LIST_OP = "tools/list";

export const assistantCaller = (turnId: string): string => `${ASSISTANT_CALLER_PREFIX}${turnId}`;

export const isAssistantCaller = (identity: string): boolean => identity.startsWith(ASSISTANT_CALLER_PREFIX);
