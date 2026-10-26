export type AnnotatedElement = {
  tag: string;
  text: string;
  openingTag: string;
  path: string;
  size: [number, number];
};

export type Annotation = { comment: string; element: AnnotatedElement };

export type AnnotationOutcome = {
  action: "send" | "cancel" | "closed" | "timeout";
  file: string;
  annotations: Annotation[];
};

export const SUBMIT_BINDING = "__claudeDesignAnnotate";

// Numbered "1. " or "- " lines would turn into lists in the claude.ai composer, so items use "[n]".
export function annotationMessage(file: string, annotations: readonly Annotation[]): string {
  const items = annotations.map(({ comment, element }, index) => {
    const where = element.text ? `<${element.tag}> with text "${element.text}"` : `<${element.tag}>`;
    return [
      `[${index + 1}] ${comment.trim()}`,
      `  Element: ${where}, about ${element.size[0]}x${element.size[1]}px`,
      `  DOM path: ${element.path}`,
      `  Opening tag: ${element.openingTag}`,
    ].join("\n");
  });
  return [
    `Revise ${file} using these comments. Each comment is attached to an element I selected on the rendered design.`,
    ...items,
    "Change only what the comments ask for and keep everything else the same.",
  ].join("\n\n");
}

// Runs inside the design page through page.evaluate, so it must not reference anything outside its own body.
export function installAnnotator(file: string): void {
  type Picked = { el: Element; comment: string; element: AnnotatedElement };
  type Submit = (payload: { action: "send" | "cancel"; annotations: Annotation[] }) => Promise<void>;
  const scope = window as unknown as Record<string, unknown>;
  if (scope.__claudeDesignAnnotator) return;
  scope.__claudeDesignAnnotator = true;

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
.box{position:fixed;display:none;pointer-events:none;border-radius:3px}
.hover{border:2px solid #2563eb;background:rgba(37,99,235,.08)}
.selected{border:2px solid #f97316;background:rgba(249,115,22,.12)}
.pin{position:fixed;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#f97316;color:#fff;font-size:12px;font-weight:600;line-height:22px;text-align:center;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.card{position:fixed;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);pointer-events:auto;font-size:13px}
.panel{right:16px;bottom:16px;width:320px;max-height:60vh;display:flex;flex-direction:column}
.title{padding:12px 14px 4px;font-weight:600}
.hint{padding:0 14px 8px;color:#666;font-size:12px}
ol{margin:0;padding:0 14px;overflow:auto;list-style:none}
li{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid #eee}
li .n{flex:none;width:20px;height:20px;border-radius:10px;background:#f97316;color:#fff;font-size:11px;line-height:20px;text-align:center}
li .body{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.what{color:#666;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
li button{flex:none;border:0;background:none;color:#999;cursor:pointer;font-size:14px}
.row{display:flex;gap:8px;padding:10px 14px 12px}
button.primary{flex:1;border:0;border-radius:8px;padding:8px 10px;background:#111;color:#fff;font-weight:600;cursor:pointer}
button.primary:disabled{background:#bbb;cursor:default}
button.secondary{border:1px solid #ddd;border-radius:8px;padding:8px 10px;background:#fff;color:#111;cursor:pointer}
.editor{width:300px;display:none}
.editor .what{padding:10px 12px 0}
textarea{display:block;width:calc(100% - 24px);height:72px;margin:6px 12px 0;resize:vertical;border:1px solid #ddd;border-radius:6px;padding:6px;font-size:13px}
.editor .row{padding:8px 12px 10px}
</style>
<div class="box hover"></div><div class="box selected"></div><div class="pins"></div>
<div class="card editor"><div class="what"></div><textarea placeholder="이 요소를 어떻게 바꿀지 적어 주세요 (⌘+Enter로 추가)"></textarea>
<div class="row"><button class="secondary parent" title="선택을 바깥 요소로 넓힙니다">상위 요소</button><button class="secondary close">닫기</button><button class="primary add">추가</button></div></div>
<div class="card panel"><div class="title"></div><div class="hint">요소를 클릭해서 주석을 다세요. 다 달았으면 보내기를 누르세요.</div><ol></ol>
<div class="row"><button class="secondary cancel">취소</button><button class="primary send" disabled>Claude Design에 보내기</button></div></div>`;

  const pick = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  const hover = pick<HTMLDivElement>(".hover");
  const selected = pick<HTMLDivElement>(".selected");
  const pins = pick<HTMLDivElement>(".pins");
  const editor = pick<HTMLDivElement>(".editor");
  const editorWhat = pick<HTMLDivElement>(".editor .what");
  const textarea = pick<HTMLTextAreaElement>("textarea");
  const list = pick<HTMLOListElement>("ol");
  const send = pick<HTMLButtonElement>(".send");
  const panel = pick<HTMLDivElement>(".panel");
  pick<HTMLDivElement>(".title").textContent = `디자인 주석 · ${file}`;

  const picked: Picked[] = [];
  let current: Element | null = null;
  let finished = false;

  const inOverlay = (event: Event) => event.composedPath().includes(host);
  const isPage = (el: Element | null) => !el || el === document.documentElement || el === document.body;
  const place = (box: HTMLElement, el: Element) => {
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };
  const textOf = (el: Element) => ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const label = (el: Element) => {
    const text = textOf(el);
    return `<${el.tagName.toLowerCase()}>${text ? ` ${text.slice(0, 60)}` : ""}`;
  };
  const pathOf = (el: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && !isPage(node) && parts.length < 8; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      const tag = node.tagName.toLowerCase();
      const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName === node?.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    }
    return parts.join(" > ");
  };
  const describe = (el: Element): AnnotatedElement => {
    const rect = el.getBoundingClientRect();
    const html = el.outerHTML;
    return {
      tag: el.tagName.toLowerCase(),
      text: textOf(el).slice(0, 160),
      openingTag: html.slice(0, html.indexOf(">") + 1).slice(0, 300),
      path: pathOf(el),
      size: [Math.round(rect.width), Math.round(rect.height)],
    };
  };

  const positionPins = () => {
    pins.replaceChildren(
      ...picked.map((item, index) => {
        const pin = document.createElement("div");
        pin.className = "pin";
        pin.textContent = String(index + 1);
        const rect = item.el.getBoundingClientRect();
        if (!item.el.isConnected) pin.style.display = "none";
        pin.style.left = `${Math.max(0, rect.left - 8)}px`;
        pin.style.top = `${Math.max(0, rect.top - 8)}px`;
        return pin;
      }),
    );
    if (current) place(selected, current);
  };
  const render = () => {
    list.replaceChildren(
      ...picked.map((item, index) => {
        const row = document.createElement("li");
        const number = document.createElement("span");
        number.className = "n";
        number.textContent = String(index + 1);
        const body = document.createElement("div");
        body.className = "body";
        const what = document.createElement("div");
        what.className = "what";
        what.textContent = label(item.el);
        body.append(document.createTextNode(item.comment), what);
        const remove = document.createElement("button");
        remove.textContent = "×";
        remove.title = "이 주석 삭제";
        remove.addEventListener("click", () => {
          picked.splice(index, 1);
          render();
        });
        row.append(number, body, remove);
        return row;
      }),
    );
    send.disabled = picked.length === 0;
    send.textContent = picked.length ? `Claude Design에 보내기 (${picked.length})` : "Claude Design에 보내기";
    positionPins();
  };
  const openEditor = (el: Element) => {
    current = el;
    place(selected, el);
    editorWhat.textContent = label(el);
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), innerWidth - 316);
    const top = rect.bottom + 170 < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 170);
    Object.assign(editor.style, { display: "block", left: `${left}px`, top: `${top}px` });
    textarea.value = "";
    textarea.focus();
  };
  const closeEditor = () => {
    current = null;
    editor.style.display = "none";
    selected.style.display = "none";
  };
  const addCurrent = () => {
    const comment = textarea.value.trim();
    if (!current || !comment) return textarea.focus();
    picked.push({ el: current, comment, element: describe(current) });
    closeEditor();
    render();
  };
  const finish = (action: "send" | "cancel") => {
    if (finished) return;
    finished = true;
    closeEditor();
    hover.style.display = "none";
    const annotations = action === "send" ? picked.map(({ comment, element }) => ({ comment, element })) : [];
    panel.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "title",
        textContent: action === "send" ? `주석 ${annotations.length}개를 보냈습니다. 이 창은 곧 닫힙니다.` : "취소했습니다. 이 창은 곧 닫힙니다.",
      }),
    );
    void (scope.__claudeDesignAnnotate as Submit | undefined)?.({ action, annotations });
  };

  document.addEventListener(
    "mousemove",
    (event) => {
      const target = event.target as Element | null;
      if (finished || inOverlay(event) || isPage(target)) hover.style.display = "none";
      else if (target) place(hover, target);
    },
    true,
  );
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "submit"]) {
    document.addEventListener(
      type,
      (event) => {
        if (finished || inOverlay(event)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
  }
  document.addEventListener(
    "click",
    (event) => {
      if (finished || inOverlay(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.target as Element | null;
      if (target && !isPage(target)) openEditor(target);
    },
    true,
  );
  textarea.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) addCurrent();
    if (event.key === "Escape") closeEditor();
  });
  pick<HTMLButtonElement>(".add").addEventListener("click", addCurrent);
  pick<HTMLButtonElement>(".close").addEventListener("click", closeEditor);
  pick<HTMLButtonElement>(".parent").addEventListener("click", () => {
    const parent = current?.parentElement ?? null;
    if (!current || isPage(parent) || !parent) return;
    current = parent;
    place(selected, parent);
    editorWhat.textContent = label(parent);
    textarea.focus();
  });
  pick<HTMLButtonElement>(".cancel").addEventListener("click", () => finish("cancel"));
  send.addEventListener("click", () => finish("send"));
  addEventListener("scroll", positionPins, true);
  addEventListener("resize", positionPins);
  render();
}
