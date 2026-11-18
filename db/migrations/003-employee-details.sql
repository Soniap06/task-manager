ALTER TABLE employees ADD COLUMN grade TEXT NOT NULL DEFAULT ''
    CHECK (grade IN ('', 'Стажёр', 'Junior', 'Middle', 'Senior', 'Lead', 'Не применимо'));
ALTER TABLE employees ADD COLUMN groups TEXT NOT NULL DEFAULT '[]'
    CHECK (CASE WHEN json_valid(groups) THEN json_type(groups) = 'array' ELSE 0 END);

CREATE TABLE employee_avatars (
    employee_id TEXT PRIMARY KEY NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL CHECK (content_type = 'image/jpeg'),
    data BLOB NOT NULL CHECK (length(data) BETWEEN 4 AND 131072)
) STRICT;
