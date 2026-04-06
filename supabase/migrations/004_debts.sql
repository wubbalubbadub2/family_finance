-- Active debts tracking
CREATE TABLE debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                -- 'Дудар', 'Халык банк', 'Каспи'
  original_amount int NOT NULL,
  remaining_amount int NOT NULL,
  note text,                         -- optional context
  created_at timestamptz DEFAULT now(),
  paid_off_at timestamptz            -- set when remaining reaches 0
);
