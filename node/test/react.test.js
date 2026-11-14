// useRows builds objects for the window it is given, and sees changes made through the table.
import { test } from "node:test";
import assert from "node:assert/strict";

let React, renderToString;
try {
  React = await import("react");
  ({ renderToString } = await import("react-dom/server"));
} catch {}
const skip = !React && "install the dev dependencies (npm ci)";

test("useRows returns the window of a table or a view", { skip }, async () => {
  const { Table } = await import("../index.js");
  const { useRows } = await import("../react.js");
  const t = new Table(Array.from({ length: 1_000 }, (_, i) => ({ id: i, even: i % 2 === 0 })));
  const seen = [];
  const List = ({ rows, offset, limit }) => {
    const got = useRows(rows, { offset, limit });
    seen.push(got);
    return React.createElement("ul", null, got.map((r) => React.createElement("li", { key: r.id }, r.id)));
  };
  const html = renderToString(React.createElement(List, { rows: t, offset: 10, limit: 3 }));
  assert.match(html, /<li>10<\/li><li>11<\/li><li>12<\/li>/);
  assert.deepEqual(seen.at(-1), [{ id: 10, even: true }, { id: 11, even: false }, { id: 12, even: true }]);
  renderToString(React.createElement(List, { rows: t.where({ even: false }), offset: 0, limit: 2 }));
  assert.deepEqual(seen.at(-1), [{ id: 1, even: false }, { id: 3, even: false }]);
  renderToString(React.createElement(List, { rows: t, offset: 998, limit: 50 }));
  assert.deepEqual(seen.at(-1).map((r) => r.id), [998, 999], "a window past the end stops at the last row");
  renderToString(React.createElement(List, { rows: null }));
  assert.deepEqual(seen.at(-1), []);
});

test("useRows keeps the same array until the window or the table changes", { skip }, async () => {
  const { Table } = await import("../index.js");
  const { useRows } = await import("../react.js");
  const t = new Table(Array.from({ length: 100 }, (_, i) => ({ id: i })));
  const a = useRows(t, { offset: 5, limit: 3 });
  assert.equal(useRows(t, { offset: 5, limit: 3 }), a, "a re-render with nothing changed gets the same array");
  assert.notEqual(useRows(t, { offset: 6, limit: 3 }), a);
  const b = useRows(t, { offset: 6, limit: 3 });
  t.set(7, { id: -7 });
  const c = useRows(t, { offset: 6, limit: 3 });
  assert.notEqual(c, b, "a change made through the table is seen");
  assert.deepEqual(c.map((r) => r.id), [6, -7, 8]);
});
