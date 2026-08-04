// Real verification that the AI assistant calls the REAL AiProvider, not
// MockAiProvider -- lib.rs hard-codes MockAiProvider for any
// cfg(debug_assertions) build, so this test is only meaningful when run
// with PROFILE=release (see wdio.conf.ts). A debug-build run of this
// exact same test would "pass" against a fake "Mock response to: ..."
// string and prove nothing about the real Gemini-backed edge function.
describe("WENZDES POS -- AI assistant (requires PROFILE=release)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await $('[data-testid="login-page"], [data-testid="pos-page"], [data-testid="sidebar"]')).isExisting(),
      { timeout: 60000, interval: 2000 }
    );
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
  });

  it("logs in as owner and reaches the AI assistant page", async () => {
    for (const digit of "123456") {
      const key = await $(`[data-testid="login-pin-digit-${digit}"]`);
      await key.waitForExist({ timeout: 10000 });
      await key.click();
    }
    const sidebar = await $('[data-testid="sidebar"]');
    await sidebar.waitForExist({ timeout: 15000 });

    const aiNav = await $('[data-testid="sidebar-nav-ai"]');
    await aiNav.waitForExist({ timeout: 10000 });
    await aiNav.click();

    const chatInput = await $('[data-testid="ai-chat-input"]');
    await chatInput.waitForExist({ timeout: 10000 });
    await expect(chatInput).toBeExisting();
  });

  it("asks a real question and gets back a real (non-mock) answer", async () => {
    const chatInput = await $('[data-testid="ai-chat-input"]');
    await chatInput.setValue("كم بعنا اليوم؟");

    const sendButton = await $('[data-testid="ai-chat-send"]');
    await sendButton.click();

    // The real provider calls a live edge function (Gemini) -- give it a
    // real network round trip's worth of time, not a UI-only timeout.
    const assistantMessages = await $$('[data-testid="ai-chat-message-assistant"]');
    await browser.waitUntil(
      async () => (await $$('[data-testid="ai-chat-message-assistant"]')).length >= 2,
      { timeout: 45000, timeoutMsg: "no second assistant message (the reply) appeared within 45s" }
    );

    const allAssistantMessages = await $$('[data-testid="ai-chat-message-assistant"]');
    const lastMessage = allAssistantMessages[allAssistantMessages.length - 1];
    const textEl = await lastMessage.$('[data-testid="ai-chat-message-text"]');
    const replyText = await textEl.getText();

    console.log("=== REAL assistant reply ===\n", replyText);

    // The one assertion that actually distinguishes "real Gemini answer"
    // from "MockAiProvider's canned string" -- if this fails, either the
    // build wasn't actually a release build, or the edge function/network
    // call itself failed and the UI is showing an error message instead.
    expect(replyText).not.toContain("Mock response to:");
    expect(replyText.length).toBeGreaterThan(10);
  });
});
