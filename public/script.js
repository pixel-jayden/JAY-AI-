const input = document.getElementById("messageInput");
const fileInput = document.getElementById("fileInput");
const attachButton = document.getElementById("attachButton");
const fileChip = document.getElementById("fileChip");
const fileIcon = document.getElementById("fileIcon");
const fileThumb = document.getElementById("fileThumb");
const fileName = document.getElementById("fileName");
const fileSize = document.getElementById("fileSize");
const fileRemove = document.getElementById("fileRemove");
const sendButton = document.getElementById("sendButton");
const messagesEl = document.getElementById("messages");
const newChatButton = document.getElementById("newChat");
const chatListEl = document.getElementById("chatList");
const sidebar = document.querySelector(".sidebar");
const mobileMenuToggle = document.getElementById("mobileMenuToggle");
const menuButton = document.getElementById("menuButton");
const menuDropdown = document.getElementById("menuDropdown");
const deleteCurrentChatButton = document.getElementById("deleteCurrentChat");
const settingsButton = document.getElementById("settingsButton");
const profileButton = document.getElementById("profileButton");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalClose = document.getElementById("modalClose");
const modalTitle = document.getElementById("modalTitle");
const modalContent = document.getElementById("modalContent");

marked.setOptions({ breaks: true });

let currentChatId = null;
let isStreaming = false;
let abortController = null;
let selectedFile = null;

init();

async function init() {
    await refreshChatList();
    autoResizeTextarea();
}

async function refreshChatList() {
    try {
        const res = await fetch("/api/chats");
        if (!res.ok) throw new Error("Failed to load chats");
        const chats = await res.json();

        chatListEl.innerHTML = "";

        chats.forEach(chat => {
            const item = document.createElement("button");
            item.className = "chat-item";
            item.textContent = chat.title || "New chat";
            item.dataset.id = chat.id;

            if (chat.id === currentChatId) item.classList.add("active");

            item.addEventListener("click", () => loadChat(chat.id));

            const renameButton = document.createElement("button");
            renameButton.className = "chat-rename";
            renameButton.type = "button";
            renameButton.title = "Rename chat";
            renameButton.setAttribute("aria-label", "Rename chat");
            renameButton.textContent = "✎";
            renameButton.addEventListener("click", event => {
                event.stopPropagation();
                renameChat(chat.id, chat.title || "New chat");
            });

            const deleteButton = document.createElement("button");
            deleteButton.className = "chat-delete";
            deleteButton.type = "button";
            deleteButton.title = "Delete chat";
            deleteButton.setAttribute("aria-label", "Delete chat");
            deleteButton.textContent = "×";
            deleteButton.addEventListener("click", event => {
                event.stopPropagation();
                deleteChat(chat.id);
            });

            const wrapper = document.createElement("div");
            wrapper.className = "chat-item-wrapper";
            wrapper.appendChild(item);
            wrapper.appendChild(renameButton);
            wrapper.appendChild(deleteButton);
            chatListEl.appendChild(wrapper);
        });
    } catch (error) {
        console.error("Could not load chats:", error);
    }
}

function setActiveChatItem(id) {
    document.querySelectorAll(".chat-item").forEach(el => {
        el.classList.toggle("active", el.dataset.id === id);
    });
}

async function loadChat(id) {
    if (isStreaming) return;

    try {
        const res = await fetch(`/api/chats/${id}`);
        if (!res.ok) return;

        const chat = await res.json();
        currentChatId = chat.id;
        setActiveChatItem(id);
        closeMobileSidebar();

        messagesEl.innerHTML = "";

        if (!chat.messages.length) {
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
    } catch (error) {
        console.error("Could not load chat:", error);
    }
}

newChatButton.addEventListener("click", async () => {
    if (isStreaming) return;

    try {
        const res = await fetch("/api/chats", { method: "POST" });
        if (!res.ok) throw new Error("Failed to create chat");

        const chat = await res.json();
        currentChatId = chat.id;
        messagesEl.innerHTML = "";
        showWelcome();
        input.value = "";
        autoResizeTextarea();
        input.focus();
        closeMobileSidebar();

        await refreshChatList();
        setActiveChatItem(chat.id);
    } catch (error) {
        console.error("Could not create chat:", error);
    }
});

function showWelcome() {
    messagesEl.innerHTML = `
        <div class="welcome">
            <img class="ai-logo" src="logo.png" alt="JAY AI logo">
            <h1>How can I help?</h1>
            <p>Ask JAY AI anything. Build something, learn something, or just have a conversation.</p>
        </div>
    `;
}

async function sendMessage() {
    if (isStreaming) return;

    const text = input.value.trim();
    if (!text && !selectedFile) return;

    let accumulated = "";
    let bubble = null;

    try {
        if (!currentChatId) {
            const res = await fetch("/api/chats", { method: "POST" });
            if (!res.ok) throw new Error("Failed to create chat");
            const chat = await res.json();
            currentChatId = chat.id;
        }

        const welcome = document.querySelector(".welcome");
        if (welcome) welcome.remove();

        const file = selectedFile;

        if (file) {
            addUserMessage(text || `Attached: ${file.name}`);
            input.value = "";
            autoResizeTextarea();
            clearSelectedFile();
            setStreamingState(true);

            bubble = addAIMessageContainer();
            addTypingLabel(bubble);

            const dataUrl = await readFileAsDataUrl(file);
            const res = await fetch(`/api/chats/${currentChatId}/analyze-file`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: file.name,
                    mimeType: file.type || "application/octet-stream",
                    data: dataUrl,
                    prompt: text || "Analyze this file and explain the important information clearly."
                })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "File analysis failed");

            accumulated = data.answer || "";
            renderMarkdownInto(bubble, accumulated);
            scrollToBottom();
            return;
        }

        addUserMessage(text);
        input.value = "";
        autoResizeTextarea();
        setStreamingState(true);

        bubble = addAIMessageContainer();
        addTypingLabel(bubble);
        abortController = new AbortController();

        const res = await fetch(`/api/chats/${currentChatId}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text }),
            signal: abortController.signal
        });

        if (!res.ok || !res.body) {
            let detail = "Request failed";
            try {
                const errorData = await res.json();
                detail = errorData.error || detail;
            } catch {}
            throw new Error(detail);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            for (const raw of events) {
                const parsed = parseSSEEvent(raw);
                if (!parsed) continue;

                if (parsed.event === "chunk") {
                    accumulated += parsed.data.text || "";
                    renderMarkdownInto(bubble, accumulated);
                    scrollToBottom();
                } else if (parsed.event === "error") {
                    renderMarkdownInto(bubble, parsed.data.error || "JAY AI could not complete that request.");
                }
            }
        }

        if (!accumulated && bubble) bubble.innerHTML = "";
    } catch (error) {
        if (error.name === "AbortError") {
            if (!accumulated) {
                const lastBubble = messagesEl.querySelector(".ai-row:last-child .ai-message");
                if (lastBubble && lastBubble.textContent.includes("JAY is thinking")) {
                    lastBubble.innerHTML = "";
                }
            }
        } else {
            console.error("Send message error:", error);
            if (bubble) renderMarkdownInto(bubble, error.message || "Something went wrong. Please try again.");
        }
    } finally {
        setStreamingState(false);
        abortController = null;
        input.focus();
        await refreshChatList();
        setActiveChatItem(currentChatId);
    }
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
    });
}

function clearSelectedFile() {
    selectedFile = null;
    fileInput.value = "";
    fileChip.hidden = true;
    fileName.textContent = "";
    fileSize.textContent = "";
    fileIcon.textContent = "📎";
    fileThumb.hidden = true;
    fileThumb.removeAttribute("src");
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(file) {
    if (file.type === "application/pdf") return "📕";
    if (file.type.startsWith("image/")) return "🖼️";
    if (file.type === "text/csv") return "📊";
    if (file.type === "application/json") return "🧾";
    if (file.type === "text/markdown") return "📝";
    if (file.type === "text/plain") return "📄";
    return "📎";
}

function showSelectedFile(file) {
    selectedFile = file;
    fileIcon.textContent = getFileIcon(file);
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    if (file.type.startsWith("image/")) {
        fileThumb.src = URL.createObjectURL(file);
        fileThumb.hidden = false;
        fileThumb.onload = () => URL.revokeObjectURL(fileThumb.src);
    } else {
        fileThumb.hidden = true;
        fileThumb.removeAttribute("src");
    }

    fileChip.hidden = false;
}

fileRemove.addEventListener("click", clearSelectedFile);

attachButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    if (file.size > 12 * 1024 * 1024) {
        alert("That file is too large. Maximum size is 12 MB.");
        clearSelectedFile();
        return;
    }

    showSelectedFile(file);
    input.focus();
});


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

function addUserMessage(text) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-row user-row";
    wrapper.innerHTML = `<div class="message user-message"></div>`;
    wrapper.querySelector(".user-message").textContent = text;
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
    btn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(codeBlock.textContent);
            btn.textContent = "Copied!";
            setTimeout(() => (btn.textContent = "Copy"), 1500);
        } catch {
            btn.textContent = "Failed";
            setTimeout(() => (btn.textContent = "Copy"), 1500);
        }
    });

    pre.style.position = "relative";
    pre.appendChild(btn);
}

function scrollToBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}

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

mobileMenuToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
});

function closeMobileSidebar() {
    sidebar.classList.remove("open");
}


async function renameChat(id, currentTitle) {
    if (isStreaming) return;

    const nextTitle = window.prompt("Rename chat:", currentTitle);
    if (nextTitle === null) return;

    const title = nextTitle.trim();
    if (!title) {
        alert("Chat name cannot be empty.");
        return;
    }

    try {
        const res = await fetch(`/api/chats/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || "Failed to rename chat");
        }

        await refreshChatList();
        setActiveChatItem(currentChatId);
    } catch (error) {
        console.error("Could not rename chat:", error);
        alert(error.message || "Could not rename the chat. Please try again.");
    }
}

async function deleteChat(id) {
    if (isStreaming) return;

    const chat = await getChatSummary(id);
    const title = chat?.title || "this chat";
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;

    try {
        const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete chat");

        if (currentChatId === id) {
            currentChatId = null;
            messagesEl.innerHTML = "";
            showWelcome();
            input.value = "";
            autoResizeTextarea();
        }

        await refreshChatList();
        if (currentChatId) setActiveChatItem(currentChatId);
    } catch (error) {
        console.error("Could not delete chat:", error);
        alert("Could not delete the chat. Please try again.");
    }
}

async function getChatSummary(id) {
    try {
        const res = await fetch(`/api/chats/${id}`);
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

deleteCurrentChatButton.addEventListener("click", async () => {
    menuDropdown.hidden = true;
    if (!currentChatId) {
        alert("There is no active chat to delete.");
        return;
    }
    await deleteChat(currentChatId);
});

menuButton.addEventListener("click", event => {
    event.stopPropagation();
    menuDropdown.hidden = !menuDropdown.hidden;
});

document.addEventListener("click", event => {
    if (!event.target.closest(".topbar-menu")) {
        menuDropdown.hidden = true;
    }
});

function openModal(title, content) {
    modalTitle.textContent = title;
    modalContent.innerHTML = content;
    modalBackdrop.hidden = false;
}

function closeModal() {
    modalBackdrop.hidden = true;
}

settingsButton.addEventListener("click", () => {
    openModal("Settings", `
        <div class="settings-list">
            <div><strong>Interface</strong><span>Ink + Cyan editorial theme</span></div>
            <div><strong>Model</strong><span>JAY AI</span></div>
            <div><strong>Storage</strong><span>Server-side chat storage</span></div>
            <div><strong>Status</strong><span>Online</span></div>
        </div>
    `);
    closeMobileSidebar();
});

profileButton.addEventListener("click", () => {
    openModal("Profile", `
        <div class="profile-card">
            <div class="profile-avatar">J</div>
            <h3>JAY AI</h3>
            <p>Built by Jayden.</p>
        </div>
    `);
    closeMobileSidebar();
});

modalClose.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", event => {
    if (event.target === modalBackdrop) closeModal();
});
document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!isStreaming) newChatButton.click();
        return;
    }

    if (event.key === "Escape") {
        closeModal();
        menuDropdown.hidden = true;
    }
});
