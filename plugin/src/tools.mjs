import { z } from "zod";

const id = z.string().uuid();
const target = z
  .object({
    selector: z.string().max(2000).optional(),
    role: z.string().max(50).optional(),
    name: z.string().max(500).optional(),
    label: z.string().max(500).optional(),
  })
  .strict()
  .refine(
    (v) => [v.selector, v.role, v.label].filter(Boolean).length === 1,
    "Provide exactly one of selector, role, label",
  );
const page = { tab_id: id };
const empty = z.object({}).strict();
export const tools = [
  [
    "browser_status",
    "List connected browser instances, short IDs and setup state without selecting or operating a browser.",
    empty,
  ],
  [
    "browser_select",
    "List browser_status and ask the user to choose an existing instance_id (reuse) or start isolated Snow. Never fall back.",
    z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("reuse"), instance_id: id }).strict(),
      z.object({ mode: z.literal("isolated"), executable: z.string().optional() }).strict(),
    ]),
  ],
  ["browser_tabs", "List pages in this session's selected browser and their ownership.", empty],
  ["browser_bind", "Exclusively bind an available tab to this session.", z.object(page).strict()],
  ["browser_new_tab", "Create and own a blank tab in the selected browser.", empty],
  ["browser_release", "Release a tab without closing it.", z.object(page).strict()],
  [
    "browser_navigate",
    "Navigate an owned tab to an HTTP(S) URL or about:blank.",
    z
      .object({
        ...page,
        url: z
          .string()
          .max(8000)
          .refine((v) => v === "about:blank" || /^https?:\/\//i.test(v)),
      })
      .strict(),
  ],
  ["browser_snapshot", "Read an owned tab's title, URL, and accessibility snapshot.", z.object(page).strict()],
  [
    "browser_click",
    "Click an element in an owned tab using a semantic locator or CSS selector.",
    z.object({ ...page, target }).strict(),
  ],
  [
    "browser_fill",
    "Fill an input in an owned tab.",
    z.object({ ...page, target, value: z.string().max(100000) }).strict(),
  ],
  [
    "browser_press",
    "Press a key on an owned tab element.",
    z.object({ ...page, target, key: z.string().max(100) }).strict(),
  ],
  [
    "browser_wait",
    "Wait for an owned tab element, with a bounded timeout.",
    z
      .object({
        ...page,
        target,
        state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
        timeout_ms: z.number().int().min(1).max(30000).default(10000),
      })
      .strict(),
  ],
  ["browser_screenshot", "Capture the owned page viewport.", z.object(page).strict()],
  [
    "browser_finish",
    "After asking the user whether to close and clean up, release or remove this session's isolated instance.",
    z.object({ close_and_cleanup: z.boolean(), confirmed_by_user: z.literal(true) }).strict(),
  ],
  [
    "browser_cleanup_retained",
    "Only after explicit user confirmation, close and clean one retained plugin-created instance.",
    z.object({ instance_id: id, confirmed_by_user: z.literal(true) }).strict(),
  ],
].map(([name, description, schema]) => ({ name, description, schema }));

export function parseTool(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.schema.parse(args ?? {});
}
