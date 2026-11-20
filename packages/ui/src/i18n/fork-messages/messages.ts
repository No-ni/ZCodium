import type { ForkLocaleMessages } from "./contract.js";

export const FORK_LOCALE_MESSAGES: ForkLocaleMessages = {
  "en-US": {},
  "zh-CN": {},
  "ja-JP": {
    "chat.attachments.handoffPending": "入力を受け付けました。添付ファイルを引き渡しています。",
    "chat.attachments.handoffFailed":
      "入力を受け付けました。添付ファイルの引き渡しに失敗しました。再試行してください。",
    "chat.attachments.retryHandoff": "引き渡しを再試行",
  },
  "ko-KR": {
    "chat.attachments.handoffPending": "입력이 수락되었습니다. 첨부파일을 전달하고 있습니다.",
    "chat.attachments.handoffFailed":
      "입력이 수락되었습니다. 첨부파일 전달에 실패했습니다. 다시 시도하세요.",
    "chat.attachments.retryHandoff": "전달 다시 시도",
  },
  "ru-RU": {
    "chat.attachments.handoffPending": "Ввод принят. Выполняется передача вложений.",
    "chat.attachments.handoffFailed":
      "Ввод принят. Не удалось передать вложения. Повторите передачу.",
    "chat.attachments.retryHandoff": "Повторить передачу",
  },
};
