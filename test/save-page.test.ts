import "./setup-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement } from "react";

/** Renders a client component into a fresh DOM at `url`, like a browser would after hydration. */
async function render(url: string, element: () => Promise<ReturnType<typeof createElement>>) {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(await element()));
  return { dom, done: () => act(async () => root.unmount()) };
}

test("the /save page's bookmark is the real bookmarklet, not a link back to /save", async () => {
  const { default: SaveFromBrowser } = await import("../src/components/SaveFromBrowser");
  const { dom, done } = await render("https://jobs.example.com/save", async () => createElement(SaveFromBrowser));
  const link = [...dom.window.document.querySelectorAll("a")].find((a) => a.textContent === "Save to JobManager")!;
  assert.ok(link, "the bookmark link is shown");
  const href = link.getAttribute("href")!;
  assert.ok(href.startsWith("javascript:"), `href is ${href.slice(0, 40)}`);
  assert.match(decodeURIComponent(href), /"https:\/\/jobs\.example\.com\/save#"/);
  await done();
});

test("with a posting in the link, /save shows it for saving", async () => {
  const { default: SaveFromBrowser } = await import("../src/components/SaveFromBrowser");
  const posting = { url: "https://micron.wd1.myworkdayjobs.com/en-US/External/job/X/Intern_JR1", title: "ML Intern", company: "Micron", location: "Boise", description_text: "Build ML systems for memory." };
  const { dom, done } = await render(`https://jobs.example.com/save#${encodeURIComponent(JSON.stringify(posting))}`, async () => createElement(SaveFromBrowser));
  const values = [...dom.window.document.querySelectorAll("input")].map((i) => i.value);
  assert.deepEqual(values, ["Micron", "ML Intern", "Boise"]);
  assert.match(dom.window.document.body.textContent!, /Build ML systems for memory/);
  await done();
});

test("signing in keeps the posting in the link", async () => {
  const { default: KeepFragment } = await import("../src/components/KeepFragment");
  const { dom, done } = await render("https://jobs.example.com/login?next=%2Fsave#%7B%22url%22%3A1%7D", async () => {
    const input = (globalThis as unknown as { document: Document }).document.createElement("input");
    input.id = "login-next";
    input.value = "/save";
    (globalThis as unknown as { document: Document }).document.body.appendChild(input);
    return createElement(KeepFragment, { inputId: "login-next" });
  });
  assert.equal((dom.window.document.getElementById("login-next") as HTMLInputElement).value, "/save#%7B%22url%22%3A1%7D");
  await done();
});
