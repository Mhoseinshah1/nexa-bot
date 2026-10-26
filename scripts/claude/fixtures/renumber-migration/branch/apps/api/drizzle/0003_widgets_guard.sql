-- hand-written: widgets are append-only
CREATE FUNCTION widgets_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append only';
END;
$$ LANGUAGE plpgsql;