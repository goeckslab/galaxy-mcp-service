import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createRequestGalaxyContext, instanceInput, sourceOutput, withGalaxy, type GalaxyConnection } from "./galaxy-connection.js";

// Element keys are single words so they read the same in camelCase and snake_case.
const datasetId = z.string().trim().min(1).max(256);
const input = z.object({
  historyId: z.string().trim().min(1).max(256).describe("Encoded id of the history that holds the datasets and receives the collection"),
  name: z.string().trim().min(1).max(255).describe("Name of the new collection"),
  collectionType: z.enum(["list", "paired", "list:paired"]).describe("list: one dataset per element. paired: a single forward/reverse pair. list:paired: one forward/reverse pair per sample."),
  elements: z.array(z.object({
    name: z.string().trim().min(1).max(255).optional().describe("Element or sample name; required and unique for list and list:paired"),
    dataset: datasetId.optional().describe("list only: encoded dataset id"),
    forward: datasetId.optional().describe("paired and list:paired: encoded id of the forward-read dataset"),
    reverse: datasetId.optional().describe("paired and list:paired: encoded id of the reverse-read dataset"),
  }).strict()).min(1).max(500).describe("In the order the collection should keep; paired takes exactly one element"),
}).strict();
const output = z.object({
  success: z.boolean(),
  data: z.object({
    id: z.string(),
    name: z.string(),
    collection_type: z.string(),
    element_count: z.number().int().min(0).optional(),
    hid: z.number().int().optional(),
    history_id: z.string(),
  }).optional(),
  message: z.string(),
});

type Elements = z.infer<typeof input>["elements"];
type Identifier = { name: string; src: "hda"; id: string }
  | { name: string; src: "new_collection"; collection_type: "paired"; element_identifiers: Identifier[] };

const pair = (forward: string, reverse: string): Identifier[] =>
  [{ name: "forward", src: "hda", id: forward }, { name: "reverse", src: "hda", id: reverse }];

/** Galaxy's element identifiers, or the reason the request cannot describe that collection type. */
export function elementIdentifiers(collectionType: z.infer<typeof input>["collectionType"], elements: Elements): Identifier[] | string {
  if (collectionType === "paired") {
    const [only] = elements;
    if (elements.length !== 1 || !only?.forward || !only.reverse || only.dataset) return "A paired collection takes exactly one element with forward and reverse.";
    return pair(only.forward, only.reverse);
  }
  const names = elements.map(element => element.name);
  if (names.some(name => !name)) return "Every element needs a name.";
  if (new Set(names).size !== names.length) return "Element names must be unique.";
  if (collectionType === "list") {
    if (elements.some(element => !element.dataset || element.forward || element.reverse)) return "Each list element takes a name and a dataset.";
    return elements.map(element => ({ name: element.name!, src: "hda", id: element.dataset! }));
  }
  if (elements.some(element => !element.forward || !element.reverse || element.dataset)) return "Each list:paired element takes a name, forward and reverse.";
  return elements.map(element => ({
    name: element.name!, src: "new_collection", collection_type: "paired", element_identifiers: pair(element.forward!, element.reverse!),
  }));
}

function result(value: z.infer<typeof output>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(!value.success && { isError: true }) };
}

async function createCollection(args: z.infer<typeof input>, connection: GalaxyConnection | undefined, signal: AbortSignal): Promise<CallToolResult> {
  if (connection === undefined) return result({ success: false, message: "Connect a Galaxy account before using this tool." });
  const identifiers = elementIdentifiers(args.collectionType, args.elements);
  if (typeof identifiers === "string") return result({ success: false, message: `${identifiers} No Galaxy request was sent.` });
  const created = await createRequestGalaxyContext(connection, signal).client.POST("/api/dataset_collections", {
    // The source datasets stay visible; Galaxy copies them into the collection.
    body: { history_id: args.historyId, name: args.name, collection_type: args.collectionType, instance_type: "history",
      element_identifiers: identifiers, copy_elements: true, hide_source_items: false, fields: [] },
  });
  if (created.error || !created.data) {
    const reason = (created.error as { err_msg?: unknown } | undefined)?.err_msg;
    return result({ success: false, message: typeof reason === "string" ? `Galaxy did not create the collection: ${reason}` : "Galaxy did not create the collection." });
  }
  const { id, collection_type, element_count, hid, history_id } = created.data;
  const name = created.data.name ?? args.name;
  return result({
    success: true,
    data: { id, name, collection_type, history_id, ...(typeof element_count === "number" && { element_count }), ...(typeof hid === "number" && { hid }) },
    message: `Created ${collection_type} collection ${name}. Pass it to tools and workflows as {src:'hdca',id}.`,
  });
}

export function registerCollections(server: McpServer, connections: GalaxyConnection[]) {
  server.registerTool("create_collection", {
    description: "Group datasets already in one history into a new list, paired or list:paired collection, as workflows and batch tools expect. The datasets stay in the history; nothing is uploaded, moved or deleted. Check that each dataset is ready with get_history_contents first.",
    inputSchema: input.extend(instanceInput), outputSchema: output.extend(sourceOutput),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ instance, ...args }, ctx) => withGalaxy(instance, connections, connection => createCollection(args, connection, ctx.mcpReq.signal)));
}
