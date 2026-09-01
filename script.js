const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const messagesEl = document.getElementById("messages");
const newChatButton = document.getElementById("newChat");
const chatListEl = document.getElementById("chatList");
const sidebar = document.querySelector(".sidebar");
const mobileMenuToggle = document.getElementById("mobileMenuToggle");

marked.setOptions({ breaks: true });

let currentChatId = null;
let isStreaming = false;
let abortController = null;

// =============================
// INIT
// =============================

init();

async function init() {
    await refreshChatList();
    autoResizeTextarea();
}

// =============================
// SIDEBAR: LOAD CHAT LIST
// =============================

async function refreshChatList() {
    const res = await fetch("/api/chats");
    const chats = await res.json();

    chatListEl.innerHTML = "";

    chats.forEach(chat => {
        const item = document.createElement("button");
        item.className = "chat-item";
        item.textContent = chat.title || "New chat";
        item.dataset.id = chat.id;

        if (chat.id === currentChatId) {
            item.classList.add("active");
        }

        item.addEventListener("click", () => loadChat(chat.id));
        chatListEl.appendChild(item);
    });
}

function setActiveChatItem(id) {
    document.querySelectorAll(".chat-item").forEach(el => {
        el.classList.toggle("active", el.dataset.id === id);
    });
}

// =============================
// LOAD AN EXISTING CHAT
// =============================

async function loadChat(id) {
    if (isStreaming) return; // don't yank the rug out mid-generation

    const res = await fetch(`/api/chats/${id}`);
    if (!res.ok) return;

    const chat = await res.json();
    currentChatId = chat.id;
    setActiveChatItem(id);
    closeMobileSidebar();

    messagesEl.innerHTML = "";

    if (chat.messages.length === 0) {
        showWelcome();
        return;
    }

    chat.messages.forEach(msg => {
        if (msg.role === "user") {
            addUserMessage(msg.content);
        } else {
            const bubble = addAIMessageContainer();
            renderMarkdownInto(bubble, msg.content);
        }
    });

    scrollToBottom();
}

// =============================
// NEW CHAT
// =============================

newChatButton.addEventListener("click", async () => {
    if (isStreaming) return;

    const res = await fetch("/api/chats", { method: "POST" });
    const chat = await res.json();

    currentChatId = chat.id;
    messagesEl.innerHTML = "";
    showWelcome();
    input.value = "";
    input.focus();
    closeMobileSidebar();

    await refreshChatList();
    setActiveChatItem(chat.id);
});

function showWelcome() {
    messagesEl.innerHTML = `
        <div class="welcome">
            <div class="ai-logo">J</div>
            <h1>How can I help?</h1>
            <p>Ask JAY AI anything. Build something, learn something, or just have a conversation.</p>
        </div>
    `;
}

// =============================
// SEND MESSAGE (streaming)
// =============================

async function sendMessage() {
    if (isStreaming) return;

    const text = input.value.trim();
    if (!text) return;

    // Lazily create a chat on the first message so empty chats never pile up.
    if (!currentChatId) {
        const res = await fetch("/api/chats", { method: "POST" });
        const chat = await res.json();
        currentChatId = chat.id;
    }

    const welcome = document.querySelector(".welcome");
    if (welcome) welcome.remove();

    addUserMessage(text);
    input.value = "";
    autoResizeTextarea();

    setStreamingState(true);

    const bubble = addAIMessageContainer();
    addTypingLabel(bubble);

    let accumulated = "";
    abortController = new AbortController();

    try {
        const res = await fetch(`/api/chats/${currentChatId}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text }),
            signal: abortController.signal
        });

        if (!res.ok || !res.body) {
            throw new Error("Request failed");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop(); // last chunk may be incomplete

            for (const raw of events) {
                const parsed = parseSSEEvent(raw);
                if (!parsed) continue;

                if (parsed.event === "chunk") {
                    accumulated += parsed.data.text;
                    renderMarkdownInto(bubble, accumulated);
                    scrollToBottom();
                } else if (parsed.event === "error") {
                    renderMarkdownInto(bubble, "Sorry, something went wrong talking to Gemini. 😕");
                }
            }
        }

        if (!accumulated) {
            bubble.innerHTML = "";
        }
    } catch (error) {
        if (error.name === "AbortError") {
            // User hit "stop" — keep whatever text has streamed in so far.
            if (!accumulated) {
                bubble.remove();
            }
        } else {
            console.error(error);
            renderMarkdownInto(bubble, "Sorry, something went wrong while connecting to Gemini. 😕");
        }
    } finally {
        setStreamingState(false);
        abortController = null;
        input.focus();
        refreshChatList(); // picks up the auto-generated title after first message
    }
}

function parseSSEEvent(raw) {
    if (!raw.trim()) return null;

    let event = "message";
    let dataLine = "";

    raw.split("\n").forEach(line => {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    });

    if (!dataLine) return null;

    try {
        return { event, data: JSON.parse(dataLine) };
    } catch {
        return null;
    }
}

// =============================
// STREAMING / STOP BUTTON STATE
// =============================

function setStreamingState(streaming) {
    isStreaming = streaming;
    sendButton.textContent = streaming ? "■" : "↑";
    sendButton.classList.toggle("stop-mode", streaming);
}

sendButton.addEventListener("click", () => {
    if (isStreaming) {
        abortController?.abort();
    } else {
        sendMessage();
    }
});

// =============================
// MESSAGE RENDERING
// =============================

function addUserMessage(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-row user-row";
    wrapper.innerHTML = `<div class="message user-message"></div>`;
    wrapper.querySelector(".user-message").textContent = text; // textContent = safe, no escaping needed
    messagesEl.appendChild(wrapper);
    scrollToBottom();
}

function addAIMessageContainer() {
    const wrapper = document.createElement("div");
    wrapper.className = "message-row ai-row";
    wrapper.innerHTML = `
        <div class="ai-avatar">J</div>
        <div class="message ai-message"></div>
    `;
    messagesEl.appendChild(wrapper);
    scrollToBottom();
    return wrapper.querySelector(".ai-message");
}

function addTypingLabel(bubble) {
    bubble.innerHTML = `
        <div class="typing-indicator">
            <span class="typing-text">JAY is thinking</span>
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
    `;
}

function renderMarkdownInto(bubble, markdownText) {
    const rawHtml = marked.parse(markdownText);
    const cleanHtml = DOMPurify.sanitize(rawHtml);
    bubble.innerHTML = cleanHtml;

    bubble.querySelectorAll("pre code").forEach(block => {
        hljs.highlightElement(block);
        addCopyButton(block);
    });
}

function addCopyButton(codeBlock) {
    const pre = codeBlock.parentElement;
    if (pre.querySelector(".copy-btn")) return;

    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
        navigator.clipboard.writeText(codeBlock.textContent);
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
    });

    pre.style.position = "relative";
    pre.appendChild(btn);
}

function scrollToBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}

// =============================
// TEXTAREA: ENTER TO SEND, AUTO-RESIZE
// =============================

input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});

input.addEventListener("input", autoResizeTextarea);

function autoResizeTextarea() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

// =============================
// MOBILE SIDEBAR TOGGLE
// =============================

mobileMenuToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
});

function closeMobileSidebar() {
    sidebar.classList.remove("open");
}
