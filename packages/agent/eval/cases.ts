/**
 * Small pull requests with known answers. Each planted bug names the file and
 * head-side line range where a correct review should flag it. "clean-refactor"
 * has no bugs: any blocker or major finding there is a false positive.
 */
export interface EvalCase {
  name: string;
  base: Record<string, string>;
  head: Record<string, string>;
  bugs: PlantedBug[];
}

export interface PlantedBug {
  id: string;
  path: string;
  /** Inclusive head-side line range the finding should point into (± tolerance). */
  lines: [number, number];
  description: string;
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

export const CASES: EvalCase[] = [
  {
    name: "pagination-off-by-one",
    base: {
      "src/paginate.js": lines(
        "export function paginate(items, page, size) {",
        "  const start = page * size;",
        "  return items.slice(start, start + size);",
        "}",
      ),
    },
    head: {
      "src/paginate.js": lines(
        "/** Returns one page of items. Pages are 1-based. */",
        "export function paginate(items, page, size) {",
        "  if (size <= 0) throw new RangeError('size must be positive');",
        "  const start = (page - 1) * size;",
        "  const end = start + size;",
        "  return items.slice(start, end + 1);",
        "}",
      ),
    },
    bugs: [
      {
        id: "slice-end",
        path: "src/paginate.js",
        lines: [5, 6],
        description: "slice end + 1 returns size + 1 items",
      },
    ],
  },
  {
    name: "unawaited-promise",
    base: {
      "src/orders.js": lines(
        "export async function placeOrder(db, order) {",
        "  await db.insert('orders', order);",
        "  return { ok: true };",
        "}",
      ),
    },
    head: {
      "src/orders.js": lines(
        "export async function placeOrder(db, mailer, order) {",
        "  try {",
        "    await db.insert('orders', order);",
        "    mailer.send(order.email, 'Order confirmed');",
        "    return { ok: true };",
        "  } catch (error) {",
        "    db.rollback();",
        "    return { ok: false, error: error.message };",
        "  }",
        "}",
      ),
    },
    bugs: [
      {
        id: "send-unawaited",
        path: "src/orders.js",
        lines: [4, 4],
        description: "mailer.send not awaited; failures escape the try",
      },
      {
        id: "rollback-unawaited",
        path: "src/orders.js",
        lines: [7, 7],
        description: "db.rollback not awaited",
      },
    ],
  },
  {
    name: "sql-injection",
    base: {
      "src/users.js": lines(
        "export function findUser(db, id) {",
        "  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
        "}",
      ),
    },
    head: {
      "src/users.js": lines(
        "export function findUser(db, id) {",
        "  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
        "}",
        "",
        "export function searchUsers(db, name) {",
        "  return db.query(`SELECT * FROM users WHERE name LIKE '%${name}%'`);",
        "}",
      ),
    },
    bugs: [
      {
        id: "sqli",
        path: "src/users.js",
        lines: [6, 6],
        description: "user input interpolated into SQL",
      },
    ],
  },
  {
    name: "clean-refactor",
    base: {
      "src/format.js": lines(
        "export function formatPrice(cents) {",
        "  var dollars = Math.floor(cents / 100);",
        "  var rest = cents % 100;",
        "  return '$' + dollars + '.' + (rest < 10 ? '0' + rest : rest);",
        "}",
      ),
    },
    head: {
      "src/format.js": lines(
        "export function formatPrice(cents) {",
        "  const dollars = Math.floor(cents / 100);",
        "  const rest = String(cents % 100).padStart(2, '0');",
        "  return `$${dollars}.${rest}`;",
        "}",
      ),
    },
    bugs: [],
  },
];
