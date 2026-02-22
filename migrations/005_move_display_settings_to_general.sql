-- Move showSparklines and useAbbreviatedUnits from docker/ to general/ namespace
-- These are display settings that apply to all metric tables (Docker, Proxmox, etc.)

UPDATE settings SET key = 'general/showSparklines' WHERE key = 'docker/showSparklines';
UPDATE settings SET key = 'general/useAbbreviatedUnits' WHERE key = 'docker/useAbbreviatedUnits';
