-- Conversation memory for multi-turn bot interactions
CREATE TABLE conversation_messages (
  id serial PRIMARY KEY,
  telegram_chat_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_conv_chat ON conversation_messages(telegram_chat_id, created_at DESC);
