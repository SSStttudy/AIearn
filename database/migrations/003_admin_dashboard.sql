ALTER TABLE users
  ADD COLUMN status ENUM('active','disabled') NOT NULL DEFAULT 'active' AFTER provider_mode,
  ADD COLUMN disabled_at DATETIME NULL AFTER status;

ALTER TABLE app_settings
  ADD COLUMN registration_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER shared_provider_expires_at;
