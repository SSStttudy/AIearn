CREATE TABLE users (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  password_hash VARCHAR(512) NOT NULL,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  provider_mode ENUM('shared','personal') NOT NULL DEFAULT 'shared',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_username (username)
);

CREATE TABLE sessions (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE app_settings (
  id TINYINT UNSIGNED PRIMARY KEY,
  shared_provider_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  shared_provider_expires_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO app_settings(id) VALUES (1);

ALTER TABLE projects
  ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id,
  ADD UNIQUE KEY uq_projects_user (user_id),
  ADD CONSTRAINT fk_projects_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE provider_configs
  ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id,
  ADD UNIQUE KEY uq_provider_user (user_id),
  ADD CONSTRAINT fk_provider_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
