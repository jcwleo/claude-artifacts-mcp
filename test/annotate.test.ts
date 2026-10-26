import { expect, test } from "bun:test";
import { type Annotation, annotationMessage } from "../src/annotate.ts";

const annotations: Annotation[] = [
  {
    comment: " 모서리를 더 둥글게 ",
    element: {
      tag: "div",
      text: "Daily streak 12 days in a row",
      openingTag: '<div style="background: #FFFFFF">',
      path: "main > section:nth-of-type(1) > div:nth-of-type(3)",
      size: [386, 174],
    },
  },
  {
    comment: "Change the label to 'Add entry'",
    element: {
      tag: "a",
      text: "Log reading",
      openingTag: '<a href="#">',
      path: "header > div > a:nth-of-type(2)",
      size: [140, 44],
    },
  },
];

test("annotationMessage carries every comment with its element, in order", () => {
  const message = annotationMessage("Main.dc.html", annotations);
  const first = message.indexOf("[1] 모서리를 더 둥글게");
  const second = message.indexOf("[2] Change the label to 'Add entry'");
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  for (const { element } of annotations) {
    expect(message).toContain(element.path);
    expect(message).toContain(element.openingTag);
    expect(message).toContain(element.text);
  }
  expect(message).toContain("Main.dc.html");
});

test("no line starts like a markdown list item, which the claude.ai composer would turn into a list", () => {
  for (const line of annotationMessage("Main.dc.html", annotations).split("\n")) {
    expect(line).not.toMatch(/^\s*(\d+\.|[-*+])\s/);
  }
});
