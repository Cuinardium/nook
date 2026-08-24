import { telegramChannel } from "eve/channels/telegram";
import { getUserByTelegramId } from "../lib/users";

export default telegramChannel({
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
  async onMessage(_ctx, message) {
    // Only allowlisted private-chat senders get through; everyone else is dropped.
    if (message.chat.type !== "private") return null;
    const user = getUserByTelegramId(message.from?.id ?? "");
    if (!user) return null;

    return {
      auth: {
        authenticator: "telegram",
        principalType: "user",
        principalId: user.principalId,
        attributes: {
          telegramUserId: user.telegramUserId,
        },
      },
      title: `nook: ${user.principalId}`,
    };
  },
});
