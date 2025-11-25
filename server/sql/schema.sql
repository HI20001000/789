-- Projects table stores basic metadata about imported workspaces
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    mode VARCHAR(50) NOT NULL,
    created_at BIGINT NOT NULL
);

-- Nodes table stores flattened tree information for each project
CREATE TABLE IF NOT EXISTS nodes (
    node_key VARCHAR(512) PRIMARY KEY,
    project_id VARCHAR(255) NOT NULL,
    type ENUM('dir', 'file') NOT NULL,
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL,
    parent TEXT,
    size BIGINT DEFAULT 0,
    last_modified BIGINT DEFAULT 0,
    mime VARCHAR(255) DEFAULT '',
    is_big TINYINT(1) DEFAULT 0,
    CONSTRAINT fk_nodes_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    INDEX idx_nodes_project (project_id),
    INDEX idx_nodes_parent (parent(255))
);

-- Project files table stores persisted copies of text file contents for fallback access
CREATE TABLE IF NOT EXISTS project_files (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(255) NOT NULL,
    path VARCHAR(512) NOT NULL,
    path_hash BINARY(32) AS (UNHEX(SHA2(path, 256))) STORED,
    mime VARCHAR(255) DEFAULT '',
    size BIGINT DEFAULT 0,
    last_modified BIGINT DEFAULT 0,
    content LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_project_files_project_path_hash (project_id, path_hash),
    INDEX idx_project_files_project (project_id),
    INDEX idx_project_files_project_path (project_id, path(191)),
    CONSTRAINT fk_project_files_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Reports table stores generated code review reports per file
CREATE TABLE IF NOT EXISTS reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(255) NOT NULL,
    path VARCHAR(512) NOT NULL,
    path_hash BINARY(32) AS (UNHEX(SHA2(path, 256))) STORED,
    report LONGTEXT NOT NULL,
    chunks_json LONGTEXT NOT NULL,
    segments_json LONGTEXT NOT NULL,
    combined_report_json LONGTEXT NULL,
    static_report_json LONGTEXT NULL,
    ai_report_json LONGTEXT NULL,
    conversation_id VARCHAR(255) DEFAULT '',
    user_id VARCHAR(255) DEFAULT '',
    generated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_reports_project_path_hash (project_id, path_hash),
    INDEX idx_reports_project (project_id),
    INDEX idx_reports_project_path (project_id, path(191)),
    CONSTRAINT fk_reports_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

