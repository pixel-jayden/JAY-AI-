const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const messages = document.getElementById("messages");
const newChatButton = document.getElementById("newChat");

let conversation = [];


// =============================
// SEND MESSAGE
// =============================

async function sendMessage() {

    const text = input.value.trim();

    if (!text) return;

    const welcome = document.querySelector(".welcome");

    if (welcome) {
        welcome.remove();
    }

    addUserMessage(text);

    input.value = "";

    sendButton.disabled = true;

    const thinking = addThinkingIndicator();

    try {

        const response = await fetch("/chat", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                message: text,
                history: conversation
            })
        });

        const data = await response.json();

        thinking.remove();

        if (!response.ok) {
            throw new Error(data.error || "Request failed");
        }

        addAIMessage(data.reply);

        conversation.push({
            role: "user",
            content: text
        });

        conversation.push({
            role: "assistant",
            content: data.reply
        });

    } catch (error) {

        console.error(error);

        thinking.remove();

        addAIMessage(
            "Sorry, something went wrong while connecting to Gemini. 😕"
        );

    } finally {

        sendButton.disabled = false;

        input.focus();

    }
}


// =============================
// USER MESSAGE
// =============================

function addUserMessage(text) {

    const wrapper = document.createElement("div");

    wrapper.className = "message-row user-row";

    wrapper.innerHTML = `
        <div class="message user-message">
            ${escapeHTML(text)}
        </div>
    `;

    messages.appendChild(wrapper);

    scrollToBottom();
}


// =============================
// AI MESSAGE
// =============================

function addAIMessage(text) {

    const wrapper = document.createElement("div");

    wrapper.className = "message-row ai-row";

    wrapper.innerHTML = `
        <div class="ai-avatar">
            J
        </div>

        <div class="message ai-message">
            ${formatAIResponse(text)}
        </div>
    `;

    messages.appendChild(wrapper);

    scrollToBottom();
}


// =============================
// THINKING INDICATOR
// =============================

function addThinkingIndicator() {

    const wrapper = document.createElement("div");

    wrapper.className = "message-row ai-row";

    wrapper.innerHTML = `
        <div class="ai-avatar">
            J
        </div>

        <div class="thinking">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;

    messages.appendChild(wrapper);

    scrollToBottom();

    return wrapper;
}


// =============================
// FORMAT GEMINI RESPONSE
// =============================

function formatAIResponse(text) {

    let html = escapeHTML(text);


    // -------------------------
    // Horizontal rules
    // -------------------------

    html = html.replace(
        /^\s*---+\s*$/gm,
        '<hr class="ai-divider">'
    );


    // -------------------------
    // Headings
    // -------------------------

    html = html.replace(
        /^####\s+(.*)$/gm,
        '<h4>$1</h4>'
    );

    html = html.replace(
        /^###\s+(.*)$/gm,
        '<h3>$1</h3>'
    );

    html = html.replace(
        /^##\s+(.*)$/gm,
        '<h2>$1</h2>'
    );

    html = html.replace(
        /^#\s+(.*)$/gm,
        '<h1>$1</h1>'
    );


    // -------------------------
    // Bold
    // -------------------------

    html = html.replace(
        /\*\*(.*?)\*\*/g,
        '<strong>$1</strong>'
    );


    // -------------------------
    // Italic
    // -------------------------

    html = html.replace(
        /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
        '<em>$1</em>'
    );


    // -------------------------
    // Bullet points
    // -------------------------

    html = html.replace(
        /^\s*[-*]\s+(.*)$/gm,
        '<li>$1</li>'
    );


    // -------------------------
    // Numbered lists
    // -------------------------

    html = html.replace(
        /^\s*\d+\.\s+(.*)$/gm,
        '<li>$1</li>'
    );


    // -------------------------
    // Convert list items
    // into unordered lists
    // -------------------------

    html = html.replace(
        /((?:<li>.*?<\/li>\s*)+)/gs,
        '<ul>$1</ul>'
    );


    // -------------------------
    // Paragraph breaks
    // -------------------------

    html = html.replace(
        /\n{2,}/g,
        '<br><br>'
    );


    // -------------------------
    // Single line breaks
    // -------------------------

    html = html.replace(
        /\n/g,
        '<br>'
    );


    return html;
}


// =============================
// ESCAPE HTML
// =============================

function escapeHTML(text) {

    const div = document.createElement("div");

    div.textContent = text;

    return div.innerHTML;
}


// =============================
// SCROLL TO BOTTOM
// =============================

function scrollToBottom() {

    messages.scrollTo({
        top: messages.scrollHeight,
        behavior: "smooth"
    });

}


// =============================
// ENTER TO SEND
// =============================

input.addEventListener("keydown", (event) => {

    if (event.key === "Enter" && !event.shiftKey) {

        event.preventDefault();

        sendMessage();

    }

});


// =============================
// SEND BUTTON
// =============================

sendButton.addEventListener("click", sendMessage);


// =============================
// NEW CHAT
// =============================

newChatButton.addEventListener("click", () => {

    conversation = [];

    messages.innerHTML = `
        <div class="welcome">

            <div class="ai-logo">J</div>

            <h1>How can I help?</h1>

            <p>
                Ask JAY AI anything. Build something,
                learn something, or just have a conversation.
            </p>

        </div>
    `;

    input.value = "";

    input.focus();

});