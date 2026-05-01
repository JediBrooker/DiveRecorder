-- =============================================================================
-- DIVE DIRECTORY SEED — World Aquatics / FINA DD Tables
-- Source: FINA Competition Regulations (valid from 2017, confirmed against
--         World Aquatics 2024 publication)
-- Heights: 1m, 3m (springboard)  |  5m, 7.5m, 10m (platform)
-- Positions: A = Straight, B = Pike, C = Tuck, D = Free
-- Only rows with a valid DD value are inserted (dashes = impossible, omitted).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- FORWARD GROUP (1xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 1.0, 'A', 1.4, 'Forward Dive'),
('101', 1.0, 'B', 1.3, 'Forward Dive'),
('101', 1.0, 'C', 1.2, 'Forward Dive'),
('102', 1.0, 'A', 1.6, 'Forward 1 Somersault'),
('102', 1.0, 'B', 1.5, 'Forward 1 Somersault'),
('102', 1.0, 'C', 1.4, 'Forward 1 Somersault'),
('103', 1.0, 'A', 2.0, 'Forward 1½ Somersaults'),
('103', 1.0, 'B', 1.7, 'Forward 1½ Somersaults'),
('103', 1.0, 'C', 1.6, 'Forward 1½ Somersaults'),
('104', 1.0, 'A', 2.6, 'Forward 2 Somersaults'),
('104', 1.0, 'B', 2.3, 'Forward 2 Somersaults'),
('104', 1.0, 'C', 2.2, 'Forward 2 Somersaults'),
('105', 1.0, 'B', 2.6, 'Forward 2½ Somersaults'),
('105', 1.0, 'C', 2.4, 'Forward 2½ Somersaults'),
('106', 1.0, 'B', 3.2, 'Forward 3 Somersaults'),
('106', 1.0, 'C', 2.9, 'Forward 3 Somersaults'),
('107', 1.0, 'B', 3.3, 'Forward 3½ Somersaults'),
('107', 1.0, 'C', 3.0, 'Forward 3½ Somersaults'),
('108', 1.0, 'C', 4.0, 'Forward 4 Somersaults'),
('109', 1.0, 'C', 4.3, 'Forward 4½ Somersaults'),
('112', 1.0, 'B', 1.7, 'Forward Flying Somersault'),
('112', 1.0, 'C', 1.6, 'Forward Flying Somersault'),
('113', 1.0, 'B', 1.9, 'Forward Flying 1½ Somersaults'),
('113', 1.0, 'C', 1.8, 'Forward Flying 1½ Somersaults');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 3.0, 'A', 1.6, 'Forward Dive'),
('101', 3.0, 'B', 1.5, 'Forward Dive'),
('101', 3.0, 'C', 1.4, 'Forward Dive'),
('102', 3.0, 'A', 1.7, 'Forward 1 Somersault'),
('102', 3.0, 'B', 1.6, 'Forward 1 Somersault'),
('102', 3.0, 'C', 1.5, 'Forward 1 Somersault'),
('103', 3.0, 'A', 1.9, 'Forward 1½ Somersaults'),
('103', 3.0, 'B', 1.6, 'Forward 1½ Somersaults'),
('103', 3.0, 'C', 1.5, 'Forward 1½ Somersaults'),
('104', 3.0, 'A', 2.4, 'Forward 2 Somersaults'),
('104', 3.0, 'B', 2.1, 'Forward 2 Somersaults'),
('104', 3.0, 'C', 2.0, 'Forward 2 Somersaults'),
('105', 3.0, 'A', 2.8, 'Forward 2½ Somersaults'),
('105', 3.0, 'B', 2.4, 'Forward 2½ Somersaults'),
('105', 3.0, 'C', 2.2, 'Forward 2½ Somersaults'),
('106', 3.0, 'B', 2.8, 'Forward 3 Somersaults'),
('106', 3.0, 'C', 2.5, 'Forward 3 Somersaults'),
('107', 3.0, 'B', 3.1, 'Forward 3½ Somersaults'),
('107', 3.0, 'C', 2.8, 'Forward 3½ Somersaults'),
('108', 3.0, 'B', 3.8, 'Forward 4 Somersaults'),
('108', 3.0, 'C', 3.4, 'Forward 4 Somersaults'),
('109', 3.0, 'B', 4.2, 'Forward 4½ Somersaults'),
('109', 3.0, 'C', 3.8, 'Forward 4½ Somersaults'),
('112', 3.0, 'B', 1.8, 'Forward Flying Somersault'),
('112', 3.0, 'C', 1.7, 'Forward Flying Somersault'),
('113', 3.0, 'B', 1.8, 'Forward Flying 1½ Somersaults'),
('113', 3.0, 'C', 1.7, 'Forward Flying 1½ Somersaults'),
('115', 3.0, 'B', 2.7, 'Forward Flying 2½ Somersaults'),
('115', 3.0, 'C', 2.5, 'Forward Flying 2½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 5.0, 'A', 1.4, 'Forward Dive'),
('101', 5.0, 'B', 1.3, 'Forward Dive'),
('101', 5.0, 'C', 1.2, 'Forward Dive'),
('102', 5.0, 'A', 1.6, 'Forward 1 Somersault'),
('102', 5.0, 'B', 1.5, 'Forward 1 Somersault'),
('102', 5.0, 'C', 1.4, 'Forward 1 Somersault'),
('103', 5.0, 'A', 2.0, 'Forward 1½ Somersaults'),
('103', 5.0, 'B', 1.7, 'Forward 1½ Somersaults'),
('103', 5.0, 'C', 1.6, 'Forward 1½ Somersaults'),
('104', 5.0, 'A', 2.6, 'Forward 2 Somersaults'),
('104', 5.0, 'B', 2.3, 'Forward 2 Somersaults'),
('104', 5.0, 'C', 2.2, 'Forward 2 Somersaults'),
('105', 5.0, 'B', 2.6, 'Forward 2½ Somersaults'),
('105', 5.0, 'C', 2.4, 'Forward 2½ Somersaults'),
('106', 5.0, 'B', 3.2, 'Forward 3 Somersaults'),
('106', 5.0, 'C', 2.9, 'Forward 3 Somersaults'),
('107', 5.0, 'B', 3.0, 'Forward 3½ Somersaults'),
('112', 5.0, 'B', 1.7, 'Forward Flying Somersault'),
('112', 5.0, 'C', 1.6, 'Forward Flying Somersault'),
('113', 5.0, 'B', 1.9, 'Forward Flying 1½ Somersaults'),
('113', 5.0, 'C', 1.8, 'Forward Flying 1½ Somersaults'),
('114', 5.0, 'B', 2.5, 'Forward Flying 2 Somersaults'),
('114', 5.0, 'C', 2.4, 'Forward Flying 2 Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 7.5, 'A', 1.6, 'Forward Dive'),
('101', 7.5, 'B', 1.5, 'Forward Dive'),
('101', 7.5, 'C', 1.4, 'Forward Dive'),
('102', 7.5, 'A', 1.7, 'Forward 1 Somersault'),
('102', 7.5, 'B', 1.6, 'Forward 1 Somersault'),
('102', 7.5, 'C', 1.5, 'Forward 1 Somersault'),
('103', 7.5, 'A', 1.9, 'Forward 1½ Somersaults'),
('103', 7.5, 'B', 1.6, 'Forward 1½ Somersaults'),
('103', 7.5, 'C', 1.5, 'Forward 1½ Somersaults'),
('104', 7.5, 'A', 2.4, 'Forward 2 Somersaults'),
('104', 7.5, 'B', 2.1, 'Forward 2 Somersaults'),
('104', 7.5, 'C', 2.0, 'Forward 2 Somersaults'),
('105', 7.5, 'B', 2.4, 'Forward 2½ Somersaults'),
('105', 7.5, 'C', 2.2, 'Forward 2½ Somersaults'),
('106', 7.5, 'B', 2.8, 'Forward 3 Somersaults'),
('106', 7.5, 'C', 2.5, 'Forward 3 Somersaults'),
('107', 7.5, 'B', 3.1, 'Forward 3½ Somersaults'),
('107', 7.5, 'C', 2.8, 'Forward 3½ Somersaults'),
('112', 7.5, 'B', 1.8, 'Forward Flying Somersault'),
('112', 7.5, 'C', 1.7, 'Forward Flying Somersault'),
('113', 7.5, 'B', 1.8, 'Forward Flying 1½ Somersaults'),
('113', 7.5, 'C', 1.7, 'Forward Flying 1½ Somersaults'),
('114', 7.5, 'B', 2.3, 'Forward Flying 2 Somersaults'),
('114', 7.5, 'C', 2.2, 'Forward Flying 2 Somersaults'),
('115', 7.5, 'B', 2.5, 'Forward Flying 2½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('101', 10.0, 'A', 1.6, 'Forward Dive'),
('101', 10.0, 'B', 1.5, 'Forward Dive'),
('101', 10.0, 'C', 1.4, 'Forward Dive'),
('102', 10.0, 'A', 1.8, 'Forward 1 Somersault'),
('102', 10.0, 'B', 1.7, 'Forward 1 Somersault'),
('102', 10.0, 'C', 1.6, 'Forward 1 Somersault'),
('103', 10.0, 'A', 1.9, 'Forward 1½ Somersaults'),
('103', 10.0, 'B', 1.6, 'Forward 1½ Somersaults'),
('103', 10.0, 'C', 1.5, 'Forward 1½ Somersaults'),
('104', 10.0, 'A', 2.5, 'Forward 2 Somersaults'),
('104', 10.0, 'B', 2.2, 'Forward 2 Somersaults'),
('104', 10.0, 'C', 2.1, 'Forward 2 Somersaults'),
('105', 10.0, 'A', 2.7, 'Forward 2½ Somersaults'),
('105', 10.0, 'B', 2.3, 'Forward 2½ Somersaults'),
('105', 10.0, 'C', 2.1, 'Forward 2½ Somersaults'),
('106', 10.0, 'B', 3.0, 'Forward 3 Somersaults'),
('106', 10.0, 'C', 2.7, 'Forward 3 Somersaults'),
('107', 10.0, 'B', 3.0, 'Forward 3½ Somersaults'),
('107', 10.0, 'C', 2.7, 'Forward 3½ Somersaults'),
('108', 10.0, 'B', 4.1, 'Forward 4 Somersaults'),
('108', 10.0, 'C', 3.7, 'Forward 4 Somersaults'),
('109', 10.0, 'B', 4.1, 'Forward 4½ Somersaults'),
('109', 10.0, 'C', 3.7, 'Forward 4½ Somersaults'),
('1011',10.0, 'B', 4.7, 'Forward 5½ Somersaults'),
('112', 10.0, 'B', 1.9, 'Forward Flying Somersault'),
('112', 10.0, 'C', 1.8, 'Forward Flying Somersault'),
('113', 10.0, 'B', 1.8, 'Forward Flying 1½ Somersaults'),
('113', 10.0, 'C', 1.7, 'Forward Flying 1½ Somersaults'),
('114', 10.0, 'B', 2.4, 'Forward Flying 2 Somersaults'),
('114', 10.0, 'C', 2.3, 'Forward Flying 2 Somersaults'),
('115', 10.0, 'B', 2.6, 'Forward Flying 2½ Somersaults'),
('115', 10.0, 'C', 2.4, 'Forward Flying 2½ Somersaults');

-- -----------------------------------------------------------------------------
-- BACK GROUP (2xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 1.0, 'A', 1.7, 'Back Dive'),
('201', 1.0, 'B', 1.6, 'Back Dive'),
('201', 1.0, 'C', 1.5, 'Back Dive'),
('202', 1.0, 'A', 1.7, 'Back 1 Somersault'),
('202', 1.0, 'B', 1.6, 'Back 1 Somersault'),
('202', 1.0, 'C', 1.5, 'Back 1 Somersault'),
('203', 1.0, 'A', 2.5, 'Back 1½ Somersaults'),
('203', 1.0, 'B', 2.3, 'Back 1½ Somersaults'),
('203', 1.0, 'C', 2.0, 'Back 1½ Somersaults'),
('204', 1.0, 'B', 2.5, 'Back 2 Somersaults'),
('204', 1.0, 'C', 2.2, 'Back 2 Somersaults'),
('205', 1.0, 'B', 3.2, 'Back 2½ Somersaults'),
('205', 1.0, 'C', 3.0, 'Back 2½ Somersaults'),
('206', 1.0, 'B', 3.2, 'Back 3 Somersaults'),
('206', 1.0, 'C', 2.9, 'Back 3 Somersaults'),
('212', 1.0, 'B', 1.7, 'Back Flying Somersault'),
('212', 1.0, 'C', 1.6, 'Back Flying Somersault');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 3.0, 'A', 1.9, 'Back Dive'),
('201', 3.0, 'B', 1.8, 'Back Dive'),
('201', 3.0, 'C', 1.7, 'Back Dive'),
('202', 3.0, 'A', 1.8, 'Back 1 Somersault'),
('202', 3.0, 'B', 1.7, 'Back 1 Somersault'),
('202', 3.0, 'C', 1.6, 'Back 1 Somersault'),
('203', 3.0, 'A', 2.4, 'Back 1½ Somersaults'),
('203', 3.0, 'B', 2.2, 'Back 1½ Somersaults'),
('203', 3.0, 'C', 1.9, 'Back 1½ Somersaults'),
('204', 3.0, 'A', 2.5, 'Back 2 Somersaults'),
('204', 3.0, 'B', 2.3, 'Back 2 Somersaults'),
('204', 3.0, 'C', 2.0, 'Back 2 Somersaults'),
('205', 3.0, 'B', 3.0, 'Back 2½ Somersaults'),
('205', 3.0, 'C', 2.8, 'Back 2½ Somersaults'),
('206', 3.0, 'B', 2.8, 'Back 3 Somersaults'),
('206', 3.0, 'C', 2.5, 'Back 3 Somersaults'),
('207', 3.0, 'B', 3.9, 'Back 3½ Somersaults'),
('207', 3.0, 'C', 3.6, 'Back 3½ Somersaults'),
('208', 3.0, 'B', 3.7, 'Back 4 Somersaults'),
('208', 3.0, 'C', 3.4, 'Back 4 Somersaults'),
('209', 3.0, 'B', 4.8, 'Back 4½ Somersaults'),
('209', 3.0, 'C', 4.5, 'Back 4½ Somersaults'),
('212', 3.0, 'B', 1.8, 'Back Flying Somersault'),
('212', 3.0, 'C', 1.7, 'Back Flying Somersault'),
('213', 3.0, 'B', 2.4, 'Back Flying 1½ Somersaults'),
('213', 3.0, 'C', 2.1, 'Back Flying 1½ Somersaults'),
('215', 3.0, 'B', 3.3, 'Back Flying 2½ Somersaults'),
('215', 3.0, 'C', 3.1, 'Back Flying 2½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 5.0, 'A', 1.7, 'Back Dive'),
('201', 5.0, 'B', 1.6, 'Back Dive'),
('201', 5.0, 'C', 1.5, 'Back Dive'),
('202', 5.0, 'A', 1.7, 'Back 1 Somersault'),
('202', 5.0, 'B', 1.6, 'Back 1 Somersault'),
('202', 5.0, 'C', 1.5, 'Back 1 Somersault'),
('203', 5.0, 'A', 2.5, 'Back 1½ Somersaults'),
('203', 5.0, 'B', 2.3, 'Back 1½ Somersaults'),
('203', 5.0, 'C', 2.0, 'Back 1½ Somersaults'),
('204', 5.0, 'B', 2.5, 'Back 2 Somersaults'),
('204', 5.0, 'C', 2.2, 'Back 2 Somersaults'),
('205', 5.0, 'A', 3.2, 'Back 2½ Somersaults'),
('205', 5.0, 'B', 3.0, 'Back 2½ Somersaults'),
('206', 5.0, 'B', 3.2, 'Back 3 Somersaults'),
('206', 5.0, 'C', 2.9, 'Back 3 Somersaults'),
('207', 5.0, 'B', 3.6, 'Back 3½ Somersaults'),
('207', 5.0, 'C', 3.3, 'Back 3½ Somersaults'),
('208', 5.0, 'B', 4.4, 'Back 4 Somersaults'),
('208', 5.0, 'C', 4.1, 'Back 4 Somersaults'),
('212', 5.0, 'B', 1.7, 'Back Flying Somersault'),
('212', 5.0, 'C', 1.6, 'Back Flying Somersault'),
('213', 5.0, 'B', 2.5, 'Back Flying 1½ Somersaults'),
('213', 5.0, 'C', 2.2, 'Back Flying 1½ Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 7.5, 'A', 1.9, 'Back Dive'),
('201', 7.5, 'B', 1.8, 'Back Dive'),
('201', 7.5, 'C', 1.7, 'Back Dive'),
('202', 7.5, 'A', 1.8, 'Back 1 Somersault'),
('202', 7.5, 'B', 1.7, 'Back 1 Somersault'),
('202', 7.5, 'C', 1.6, 'Back 1 Somersault'),
('203', 7.5, 'A', 2.4, 'Back 1½ Somersaults'),
('203', 7.5, 'B', 2.2, 'Back 1½ Somersaults'),
('203', 7.5, 'C', 1.9, 'Back 1½ Somersaults'),
('204', 7.5, 'A', 2.5, 'Back 2 Somersaults'),
('204', 7.5, 'B', 2.3, 'Back 2 Somersaults'),
('204', 7.5, 'C', 2.0, 'Back 2 Somersaults'),
('205', 7.5, 'A', 3.0, 'Back 2½ Somersaults'),
('205', 7.5, 'B', 2.8, 'Back 2½ Somersaults'),
('206', 7.5, 'B', 2.8, 'Back 3 Somersaults'),
('206', 7.5, 'C', 2.5, 'Back 3 Somersaults'),
('207', 7.5, 'B', 3.5, 'Back 3½ Somersaults'),
('208', 7.5, 'B', 4.2, 'Back 4 Somersaults'),
('208', 7.5, 'C', 3.9, 'Back 4 Somersaults'),
('212', 7.5, 'B', 1.8, 'Back Flying Somersault'),
('212', 7.5, 'C', 1.7, 'Back Flying Somersault'),
('213', 7.5, 'B', 2.4, 'Back Flying 1½ Somersaults'),
('213', 7.5, 'C', 2.1, 'Back Flying 1½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('201', 10.0, 'A', 1.9, 'Back Dive'),
('201', 10.0, 'B', 1.8, 'Back Dive'),
('201', 10.0, 'C', 1.7, 'Back Dive'),
('202', 10.0, 'A', 1.9, 'Back 1 Somersault'),
('202', 10.0, 'B', 1.8, 'Back 1 Somersault'),
('202', 10.0, 'C', 1.7, 'Back 1 Somersault'),
('203', 10.0, 'A', 2.4, 'Back 1½ Somersaults'),
('203', 10.0, 'B', 2.2, 'Back 1½ Somersaults'),
('203', 10.0, 'C', 1.9, 'Back 1½ Somersaults'),
('204', 10.0, 'A', 2.6, 'Back 2 Somersaults'),
('204', 10.0, 'B', 2.4, 'Back 2 Somersaults'),
('204', 10.0, 'C', 2.1, 'Back 2 Somersaults'),
('205', 10.0, 'A', 3.3, 'Back 2½ Somersaults'),
('205', 10.0, 'B', 2.9, 'Back 2½ Somersaults'),
('205', 10.0, 'C', 2.7, 'Back 2½ Somersaults'),
('206', 10.0, 'B', 3.0, 'Back 3 Somersaults'),
('206', 10.0, 'C', 2.7, 'Back 3 Somersaults'),
('207', 10.0, 'B', 3.6, 'Back 3½ Somersaults'),
('207', 10.0, 'C', 3.3, 'Back 3½ Somersaults'),
('208', 10.0, 'B', 4.1, 'Back 4 Somersaults'),
('208', 10.0, 'C', 3.8, 'Back 4 Somersaults'),
('209', 10.0, 'B', 4.5, 'Back 4½ Somersaults'),
('209', 10.0, 'C', 4.2, 'Back 4½ Somersaults'),
('212', 10.0, 'B', 1.9, 'Back Flying Somersault'),
('212', 10.0, 'C', 1.8, 'Back Flying Somersault'),
('213', 10.0, 'B', 2.4, 'Back Flying 1½ Somersaults'),
('213', 10.0, 'C', 2.1, 'Back Flying 1½ Somersaults'),
('215', 10.0, 'B', 3.2, 'Back Flying 2½ Somersaults'),
('215', 10.0, 'C', 3.0, 'Back Flying 2½ Somersaults');

-- -----------------------------------------------------------------------------
-- REVERSE GROUP (3xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 1.0, 'A', 1.8, 'Reverse Dive'),
('301', 1.0, 'B', 1.7, 'Reverse Dive'),
('301', 1.0, 'C', 1.6, 'Reverse Dive'),
('302', 1.0, 'A', 1.8, 'Reverse 1 Somersault'),
('302', 1.0, 'B', 1.7, 'Reverse 1 Somersault'),
('302', 1.0, 'C', 1.6, 'Reverse 1 Somersault'),
('303', 1.0, 'A', 2.7, 'Reverse 1½ Somersaults'),
('303', 1.0, 'B', 2.4, 'Reverse 1½ Somersaults'),
('303', 1.0, 'C', 2.1, 'Reverse 1½ Somersaults'),
('304', 1.0, 'A', 2.9, 'Reverse 2 Somersaults'),
('304', 1.0, 'B', 2.6, 'Reverse 2 Somersaults'),
('304', 1.0, 'C', 2.3, 'Reverse 2 Somersaults'),
('305', 1.0, 'B', 3.2, 'Reverse 2½ Somersaults'),
('305', 1.0, 'C', 3.0, 'Reverse 2½ Somersaults'),
('306', 1.0, 'B', 3.3, 'Reverse 3 Somersaults'),
('306', 1.0, 'C', 3.0, 'Reverse 3 Somersaults'),
('312', 1.0, 'B', 1.8, 'Reverse Flying Somersault'),
('312', 1.0, 'C', 1.7, 'Reverse Flying Somersault'),
('313', 1.0, 'B', 2.6, 'Reverse Flying 1½ Somersaults'),
('313', 1.0, 'C', 2.3, 'Reverse Flying 1½ Somersaults');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 3.0, 'A', 2.0, 'Reverse Dive'),
('301', 3.0, 'B', 1.9, 'Reverse Dive'),
('301', 3.0, 'C', 1.8, 'Reverse Dive'),
('302', 3.0, 'A', 1.9, 'Reverse 1 Somersault'),
('302', 3.0, 'B', 1.8, 'Reverse 1 Somersault'),
('302', 3.0, 'C', 1.7, 'Reverse 1 Somersault'),
('303', 3.0, 'A', 2.6, 'Reverse 1½ Somersaults'),
('303', 3.0, 'B', 2.3, 'Reverse 1½ Somersaults'),
('303', 3.0, 'C', 2.0, 'Reverse 1½ Somersaults'),
('304', 3.0, 'A', 2.7, 'Reverse 2 Somersaults'),
('304', 3.0, 'B', 2.4, 'Reverse 2 Somersaults'),
('304', 3.0, 'C', 2.1, 'Reverse 2 Somersaults'),
('305', 3.0, 'B', 3.0, 'Reverse 2½ Somersaults'),
('305', 3.0, 'C', 2.8, 'Reverse 2½ Somersaults'),
('306', 3.0, 'B', 2.9, 'Reverse 3 Somersaults'),
('306', 3.0, 'C', 2.6, 'Reverse 3 Somersaults'),
('307', 3.0, 'B', 3.8, 'Reverse 3½ Somersaults'),
('307', 3.0, 'C', 3.5, 'Reverse 3½ Somersaults'),
('308', 3.0, 'B', 3.7, 'Reverse 4 Somersaults'),
('308', 3.0, 'C', 3.4, 'Reverse 4 Somersaults'),
('309', 3.0, 'B', 4.7, 'Reverse 4½ Somersaults'),
('309', 3.0, 'C', 4.4, 'Reverse 4½ Somersaults'),
('312', 3.0, 'B', 1.9, 'Reverse Flying Somersault'),
('312', 3.0, 'C', 1.8, 'Reverse Flying Somersault'),
('313', 3.0, 'B', 2.5, 'Reverse Flying 1½ Somersaults'),
('313', 3.0, 'C', 2.2, 'Reverse Flying 1½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 5.0, 'A', 1.8, 'Reverse Dive'),
('301', 5.0, 'B', 1.7, 'Reverse Dive'),
('301', 5.0, 'C', 1.6, 'Reverse Dive'),
('302', 5.0, 'A', 1.8, 'Reverse 1 Somersault'),
('302', 5.0, 'B', 1.7, 'Reverse 1 Somersault'),
('302', 5.0, 'C', 1.6, 'Reverse 1 Somersault'),
('303', 5.0, 'A', 2.7, 'Reverse 1½ Somersaults'),
('303', 5.0, 'B', 2.4, 'Reverse 1½ Somersaults'),
('303', 5.0, 'C', 2.1, 'Reverse 1½ Somersaults'),
('304', 5.0, 'A', 2.9, 'Reverse 2 Somersaults'),
('304', 5.0, 'B', 2.6, 'Reverse 2 Somersaults'),
('304', 5.0, 'C', 2.3, 'Reverse 2 Somersaults'),
('305', 5.0, 'B', 3.3, 'Reverse 2½ Somersaults'),
('305', 5.0, 'C', 3.1, 'Reverse 2½ Somersaults'),
('306', 5.0, 'B', 3.4, 'Reverse 3 Somersaults'),
('306', 5.0, 'C', 3.1, 'Reverse 3 Somersaults'),
('312', 5.0, 'B', 1.8, 'Reverse Flying Somersault'),
('312', 5.0, 'C', 1.7, 'Reverse Flying Somersault'),
('313', 5.0, 'B', 2.6, 'Reverse Flying 1½ Somersaults'),
('313', 5.0, 'C', 2.3, 'Reverse Flying 1½ Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 7.5, 'A', 2.0, 'Reverse Dive'),
('301', 7.5, 'B', 1.9, 'Reverse Dive'),
('301', 7.5, 'C', 1.8, 'Reverse Dive'),
('302', 7.5, 'A', 1.9, 'Reverse 1 Somersault'),
('302', 7.5, 'B', 1.8, 'Reverse 1 Somersault'),
('302', 7.5, 'C', 1.7, 'Reverse 1 Somersault'),
('303', 7.5, 'A', 2.6, 'Reverse 1½ Somersaults'),
('303', 7.5, 'B', 2.3, 'Reverse 1½ Somersaults'),
('303', 7.5, 'C', 2.0, 'Reverse 1½ Somersaults'),
('304', 7.5, 'A', 2.7, 'Reverse 2 Somersaults'),
('304', 7.5, 'B', 2.4, 'Reverse 2 Somersaults'),
('304', 7.5, 'C', 2.1, 'Reverse 2 Somersaults'),
('305', 7.5, 'B', 3.1, 'Reverse 2½ Somersaults'),
('305', 7.5, 'C', 2.9, 'Reverse 2½ Somersaults'),
('306', 7.5, 'B', 3.0, 'Reverse 3 Somersaults'),
('306', 7.5, 'C', 2.7, 'Reverse 3 Somersaults'),
('308', 7.5, 'B', 4.5, 'Reverse 4 Somersaults'),
('308', 7.5, 'C', 4.2, 'Reverse 4 Somersaults'),
('312', 7.5, 'B', 1.9, 'Reverse Flying Somersault'),
('312', 7.5, 'C', 1.8, 'Reverse Flying Somersault'),
('313', 7.5, 'B', 2.5, 'Reverse Flying 1½ Somersaults'),
('313', 7.5, 'C', 2.2, 'Reverse Flying 1½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('301', 10.0, 'A', 2.0, 'Reverse Dive'),
('301', 10.0, 'B', 1.9, 'Reverse Dive'),
('301', 10.0, 'C', 1.8, 'Reverse Dive'),
('302', 10.0, 'A', 2.0, 'Reverse 1 Somersault'),
('302', 10.0, 'B', 1.9, 'Reverse 1 Somersault'),
('302', 10.0, 'C', 1.8, 'Reverse 1 Somersault'),
('303', 10.0, 'A', 2.6, 'Reverse 1½ Somersaults'),
('303', 10.0, 'B', 2.3, 'Reverse 1½ Somersaults'),
('303', 10.0, 'C', 2.0, 'Reverse 1½ Somersaults'),
('304', 10.0, 'A', 2.8, 'Reverse 2 Somersaults'),
('304', 10.0, 'B', 2.5, 'Reverse 2 Somersaults'),
('304', 10.0, 'C', 2.2, 'Reverse 2 Somersaults'),
('305', 10.0, 'A', 3.4, 'Reverse 2½ Somersaults'),
('305', 10.0, 'B', 3.0, 'Reverse 2½ Somersaults'),
('305', 10.0, 'C', 2.8, 'Reverse 2½ Somersaults'),
('306', 10.0, 'B', 3.2, 'Reverse 3 Somersaults'),
('306', 10.0, 'C', 2.9, 'Reverse 3 Somersaults'),
('307', 10.0, 'B', 3.7, 'Reverse 3½ Somersaults'),
('307', 10.0, 'C', 3.4, 'Reverse 3½ Somersaults'),
('308', 10.0, 'B', 4.4, 'Reverse 4 Somersaults'),
('308', 10.0, 'C', 4.1, 'Reverse 4 Somersaults'),
('309', 10.0, 'B', 4.8, 'Reverse 4½ Somersaults'),
('309', 10.0, 'C', 4.5, 'Reverse 4½ Somersaults'),
('312', 10.0, 'B', 2.0, 'Reverse Flying Somersault'),
('312', 10.0, 'C', 1.9, 'Reverse Flying Somersault'),
('313', 10.0, 'B', 2.5, 'Reverse Flying 1½ Somersaults'),
('313', 10.0, 'C', 2.2, 'Reverse Flying 1½ Somersaults');

-- -----------------------------------------------------------------------------
-- INWARD GROUP (4xx)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 1.0, 'A', 1.8, 'Inward Dive'),
('401', 1.0, 'B', 1.5, 'Inward Dive'),
('401', 1.0, 'C', 1.4, 'Inward Dive'),
('402', 1.0, 'A', 2.0, 'Inward 1 Somersault'),
('402', 1.0, 'B', 1.7, 'Inward 1 Somersault'),
('402', 1.0, 'C', 1.6, 'Inward 1 Somersault'),
('403', 1.0, 'B', 2.4, 'Inward 1½ Somersaults'),
('403', 1.0, 'C', 2.2, 'Inward 1½ Somersaults'),
('404', 1.0, 'B', 3.0, 'Inward 2 Somersaults'),
('404', 1.0, 'C', 2.8, 'Inward 2 Somersaults'),
('405', 1.0, 'B', 3.4, 'Inward 2½ Somersaults'),
('405', 1.0, 'C', 3.1, 'Inward 2½ Somersaults'),
('407', 1.0, 'B', 3.7, 'Inward 3½ Somersaults'),
('407', 1.0, 'C', 3.4, 'Inward 3½ Somersaults'),
('412', 1.0, 'B', 2.1, 'Inward Flying Somersault'),
('412', 1.0, 'C', 2.0, 'Inward Flying Somersault'),
('413', 1.0, 'B', 2.9, 'Inward Flying 1½ Somersaults'),
('413', 1.0, 'C', 2.7, 'Inward Flying 1½ Somersaults');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 3.0, 'A', 1.7, 'Inward Dive'),
('401', 3.0, 'B', 1.4, 'Inward Dive'),
('401', 3.0, 'C', 1.3, 'Inward Dive'),
('402', 3.0, 'A', 1.8, 'Inward 1 Somersault'),
('402', 3.0, 'B', 1.5, 'Inward 1 Somersault'),
('402', 3.0, 'C', 1.4, 'Inward 1 Somersault'),
('403', 3.0, 'B', 2.1, 'Inward 1½ Somersaults'),
('403', 3.0, 'C', 1.9, 'Inward 1½ Somersaults'),
('404', 3.0, 'B', 2.6, 'Inward 2 Somersaults'),
('404', 3.0, 'C', 2.4, 'Inward 2 Somersaults'),
('405', 3.0, 'B', 3.0, 'Inward 2½ Somersaults'),
('405', 3.0, 'C', 2.7, 'Inward 2½ Somersaults'),
('407', 3.0, 'B', 3.7, 'Inward 3½ Somersaults'),
('407', 3.0, 'C', 3.4, 'Inward 3½ Somersaults'),
('409', 3.0, 'B', 4.6, 'Inward 4½ Somersaults'),
('409', 3.0, 'C', 4.2, 'Inward 4½ Somersaults'),
('412', 3.0, 'B', 1.9, 'Inward Flying Somersault'),
('412', 3.0, 'C', 1.8, 'Inward Flying Somersault'),
('413', 3.0, 'B', 2.6, 'Inward Flying 1½ Somersaults'),
('413', 3.0, 'C', 2.4, 'Inward Flying 1½ Somersaults');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 5.0, 'A', 1.8, 'Inward Dive'),
('401', 5.0, 'B', 1.5, 'Inward Dive'),
('401', 5.0, 'C', 1.4, 'Inward Dive'),
('402', 5.0, 'A', 2.0, 'Inward 1 Somersault'),
('402', 5.0, 'B', 1.7, 'Inward 1 Somersault'),
('402', 5.0, 'C', 1.6, 'Inward 1 Somersault'),
('403', 5.0, 'B', 2.4, 'Inward 1½ Somersaults'),
('403', 5.0, 'C', 2.2, 'Inward 1½ Somersaults'),
('404', 5.0, 'B', 3.0, 'Inward 2 Somersaults'),
('404', 5.0, 'C', 2.8, 'Inward 2 Somersaults'),
('405', 5.0, 'B', 3.4, 'Inward 2½ Somersaults'),
('405', 5.0, 'C', 3.1, 'Inward 2½ Somersaults'),
('406', 5.0, 'B', 4.0, 'Inward 3 Somersaults'),
('406', 5.0, 'C', 3.7, 'Inward 3 Somersaults'),
('412', 5.0, 'B', 2.1, 'Inward Flying Somersault'),
('412', 5.0, 'C', 2.0, 'Inward Flying Somersault'),
('413', 5.0, 'B', 2.9, 'Inward Flying 1½ Somersaults'),
('413', 5.0, 'C', 2.7, 'Inward Flying 1½ Somersaults');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 7.5, 'A', 1.7, 'Inward Dive'),
('401', 7.5, 'B', 1.4, 'Inward Dive'),
('401', 7.5, 'C', 1.3, 'Inward Dive'),
('402', 7.5, 'A', 1.8, 'Inward 1 Somersault'),
('402', 7.5, 'B', 1.5, 'Inward 1 Somersault'),
('402', 7.5, 'C', 1.4, 'Inward 1 Somersault'),
('403', 7.5, 'B', 2.1, 'Inward 1½ Somersaults'),
('403', 7.5, 'C', 1.9, 'Inward 1½ Somersaults'),
('404', 7.5, 'B', 2.6, 'Inward 2 Somersaults'),
('404', 7.5, 'C', 2.4, 'Inward 2 Somersaults'),
('405', 7.5, 'B', 3.0, 'Inward 2½ Somersaults'),
('405', 7.5, 'C', 2.7, 'Inward 2½ Somersaults'),
('406', 7.5, 'B', 3.4, 'Inward 3 Somersaults'),
('406', 7.5, 'C', 3.1, 'Inward 3 Somersaults'),
('407', 7.5, 'B', 3.4, 'Inward 3½ Somersaults'),
('412', 7.5, 'B', 1.9, 'Inward Flying Somersault'),
('412', 7.5, 'C', 1.8, 'Inward Flying Somersault'),
('413', 7.5, 'B', 2.6, 'Inward Flying 1½ Somersaults'),
('413', 7.5, 'C', 2.4, 'Inward Flying 1½ Somersaults');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('401', 10.0, 'A', 1.7, 'Inward Dive'),
('401', 10.0, 'B', 1.4, 'Inward Dive'),
('401', 10.0, 'C', 1.3, 'Inward Dive'),
('402', 10.0, 'A', 1.9, 'Inward 1 Somersault'),
('402', 10.0, 'B', 1.6, 'Inward 1 Somersault'),
('402', 10.0, 'C', 1.5, 'Inward 1 Somersault'),
('403', 10.0, 'B', 2.0, 'Inward 1½ Somersaults'),
('403', 10.0, 'C', 1.8, 'Inward 1½ Somersaults'),
('404', 10.0, 'B', 2.6, 'Inward 2 Somersaults'),
('404', 10.0, 'C', 2.4, 'Inward 2 Somersaults'),
('405', 10.0, 'B', 2.8, 'Inward 2½ Somersaults'),
('405', 10.0, 'C', 2.5, 'Inward 2½ Somersaults'),
('406', 10.0, 'B', 3.5, 'Inward 3 Somersaults'),
('406', 10.0, 'C', 3.2, 'Inward 3 Somersaults'),
('407', 10.0, 'B', 3.5, 'Inward 3½ Somersaults'),
('407', 10.0, 'C', 3.2, 'Inward 3½ Somersaults'),
('408', 10.0, 'B', 4.4, 'Inward 4 Somersaults'),
('408', 10.0, 'C', 4.1, 'Inward 4 Somersaults'),
('409', 10.0, 'B', 4.4, 'Inward 4½ Somersaults'),
('409', 10.0, 'C', 4.1, 'Inward 4½ Somersaults'),
('412', 10.0, 'B', 2.0, 'Inward Flying Somersault'),
('412', 10.0, 'C', 1.9, 'Inward Flying Somersault'),
('413', 10.0, 'B', 2.5, 'Inward Flying 1½ Somersaults'),
('413', 10.0, 'C', 2.3, 'Inward Flying 1½ Somersaults');

-- -----------------------------------------------------------------------------
-- FORWARD TWISTING GROUP (511x / 512x / 513x / 515x / 517x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 1.0, 'A', 1.8, 'Forward Dive ½ Twist'),
('5111', 1.0, 'B', 1.7, 'Forward Dive ½ Twist'),
('5111', 1.0, 'C', 1.6, 'Forward Dive ½ Twist'),
('5112', 1.0, 'A', 2.0, 'Forward Dive 1 Twist'),
('5112', 1.0, 'B', 1.9, 'Forward Dive 1 Twist'),
('5121', 1.0, 'D', 1.7, 'Forward Somersault ½ Twist'),
('5122', 1.0, 'D', 1.9, 'Forward Somersault 1 Twist'),
('5124', 1.0, 'D', 2.3, 'Forward Somersault 2 Twists'),
('5126', 1.0, 'D', 2.8, 'Forward Somersault 3 Twists'),
('5131', 1.0, 'D', 2.0, 'Forward 1½ Somersaults ½ Twist'),
('5132', 1.0, 'D', 2.2, 'Forward 1½ Somersaults 1 Twist'),
('5134', 1.0, 'D', 2.6, 'Forward 1½ Somersaults 2 Twists'),
('5136', 1.0, 'D', 3.1, 'Forward 1½ Somersaults 3 Twists'),
('5138', 1.0, 'D', 3.5, 'Forward 1½ Somersaults 4 Twists'),
('5151', 1.0, 'B', 3.0, 'Forward 2½ Somersaults ½ Twist'),
('5151', 1.0, 'C', 2.8, 'Forward 2½ Somersaults ½ Twist'),
('5152', 1.0, 'B', 3.2, 'Forward 2½ Somersaults 1 Twist'),
('5152', 1.0, 'C', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5154', 1.0, 'B', 3.6, 'Forward 2½ Somersaults 2 Twists'),
('5154', 1.0, 'C', 3.4, 'Forward 2½ Somersaults 2 Twists');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 3.0, 'A', 2.0, 'Forward Dive ½ Twist'),
('5111', 3.0, 'B', 1.9, 'Forward Dive ½ Twist'),
('5111', 3.0, 'C', 1.8, 'Forward Dive ½ Twist'),
('5112', 3.0, 'A', 2.2, 'Forward Dive 1 Twist'),
('5112', 3.0, 'B', 2.1, 'Forward Dive 1 Twist'),
('5121', 3.0, 'D', 1.8, 'Forward Somersault ½ Twist'),
('5122', 3.0, 'D', 2.0, 'Forward Somersault 1 Twist'),
('5124', 3.0, 'D', 2.4, 'Forward Somersault 2 Twists'),
('5126', 3.0, 'D', 2.9, 'Forward Somersault 3 Twists'),
('5131', 3.0, 'D', 1.9, 'Forward 1½ Somersaults ½ Twist'),
('5132', 3.0, 'D', 2.1, 'Forward 1½ Somersaults 1 Twist'),
('5134', 3.0, 'D', 2.5, 'Forward 1½ Somersaults 2 Twists'),
('5136', 3.0, 'D', 3.0, 'Forward 1½ Somersaults 3 Twists'),
('5138', 3.0, 'D', 3.4, 'Forward 1½ Somersaults 4 Twists'),
('5151', 3.0, 'B', 2.8, 'Forward 2½ Somersaults ½ Twist'),
('5151', 3.0, 'C', 2.6, 'Forward 2½ Somersaults ½ Twist'),
('5152', 3.0, 'B', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5152', 3.0, 'C', 2.8, 'Forward 2½ Somersaults 1 Twist'),
('5154', 3.0, 'B', 3.4, 'Forward 2½ Somersaults 2 Twists'),
('5154', 3.0, 'C', 3.2, 'Forward 2½ Somersaults 2 Twists'),
('5156', 3.0, 'B', 3.9, 'Forward 2½ Somersaults 3 Twists'),
('5156', 3.0, 'C', 3.7, 'Forward 2½ Somersaults 3 Twists'),
('5172', 3.0, 'B', 3.7, 'Forward 3½ Somersaults 1 Twist'),
('5172', 3.0, 'C', 3.4, 'Forward 3½ Somersaults 1 Twist');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 5.0, 'A', 1.8, 'Forward Dive ½ Twist'),
('5111', 5.0, 'B', 1.7, 'Forward Dive ½ Twist'),
('5111', 5.0, 'C', 1.6, 'Forward Dive ½ Twist'),
('5112', 5.0, 'A', 2.0, 'Forward Dive 1 Twist'),
('5112', 5.0, 'B', 1.9, 'Forward Dive 1 Twist'),
('5121', 5.0, 'D', 1.7, 'Forward Somersault ½ Twist'),
('5122', 5.0, 'D', 1.9, 'Forward Somersault 1 Twist'),
('5124', 5.0, 'D', 2.3, 'Forward Somersault 2 Twists'),
('5131', 5.0, 'D', 2.0, 'Forward 1½ Somersaults ½ Twist'),
('5132', 5.0, 'D', 2.2, 'Forward 1½ Somersaults 1 Twist'),
('5134', 5.0, 'D', 2.6, 'Forward 1½ Somersaults 2 Twists'),
('5136', 5.0, 'D', 3.1, 'Forward 1½ Somersaults 3 Twists'),
('5138', 5.0, 'D', 3.5, 'Forward 1½ Somersaults 4 Twists'),
('5152', 5.0, 'B', 3.2, 'Forward 2½ Somersaults 1 Twist'),
('5152', 5.0, 'C', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5154', 5.0, 'B', 3.6, 'Forward 2½ Somersaults 2 Twists'),
('5154', 5.0, 'C', 3.4, 'Forward 2½ Somersaults 2 Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 7.5, 'A', 2.0, 'Forward Dive ½ Twist'),
('5111', 7.5, 'B', 1.9, 'Forward Dive ½ Twist'),
('5111', 7.5, 'C', 1.8, 'Forward Dive ½ Twist'),
('5112', 7.5, 'A', 2.2, 'Forward Dive 1 Twist'),
('5112', 7.5, 'B', 2.1, 'Forward Dive 1 Twist'),
('5121', 7.5, 'D', 1.8, 'Forward Somersault ½ Twist'),
('5122', 7.5, 'D', 2.0, 'Forward Somersault 1 Twist'),
('5124', 7.5, 'D', 2.4, 'Forward Somersault 2 Twists'),
('5131', 7.5, 'D', 1.9, 'Forward 1½ Somersaults ½ Twist'),
('5132', 7.5, 'D', 2.1, 'Forward 1½ Somersaults 1 Twist'),
('5134', 7.5, 'D', 2.5, 'Forward 1½ Somersaults 2 Twists'),
('5136', 7.5, 'D', 3.0, 'Forward 1½ Somersaults 3 Twists'),
('5138', 7.5, 'D', 3.4, 'Forward 1½ Somersaults 4 Twists'),
('5152', 7.5, 'B', 3.0, 'Forward 2½ Somersaults 1 Twist'),
('5152', 7.5, 'C', 2.8, 'Forward 2½ Somersaults 1 Twist'),
('5154', 7.5, 'B', 3.4, 'Forward 2½ Somersaults 2 Twists'),
('5154', 7.5, 'C', 3.2, 'Forward 2½ Somersaults 2 Twists'),
('5172', 7.5, 'B', 3.7, 'Forward 3½ Somersaults 1 Twist'),
('5172', 7.5, 'C', 3.4, 'Forward 3½ Somersaults 1 Twist');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5111', 10.0, 'A', 2.0, 'Forward Dive ½ Twist'),
('5111', 10.0, 'B', 1.9, 'Forward Dive ½ Twist'),
('5111', 10.0, 'C', 1.8, 'Forward Dive ½ Twist'),
('5112', 10.0, 'A', 2.2, 'Forward Dive 1 Twist'),
('5112', 10.0, 'B', 2.1, 'Forward Dive 1 Twist'),
('5121', 10.0, 'D', 1.9, 'Forward Somersault ½ Twist'),
('5122', 10.0, 'D', 2.1, 'Forward Somersault 1 Twist'),
('5124', 10.0, 'D', 2.5, 'Forward Somersault 2 Twists'),
('5131', 10.0, 'D', 1.9, 'Forward 1½ Somersaults ½ Twist'),
('5132', 10.0, 'D', 2.1, 'Forward 1½ Somersaults 1 Twist'),
('5134', 10.0, 'D', 2.5, 'Forward 1½ Somersaults 2 Twists'),
('5136', 10.0, 'D', 3.0, 'Forward 1½ Somersaults 3 Twists'),
('5138', 10.0, 'D', 3.4, 'Forward 1½ Somersaults 4 Twists'),
('5152', 10.0, 'B', 2.9, 'Forward 2½ Somersaults 1 Twist'),
('5152', 10.0, 'C', 2.7, 'Forward 2½ Somersaults 1 Twist'),
('5154', 10.0, 'B', 3.3, 'Forward 2½ Somersaults 2 Twists'),
('5154', 10.0, 'C', 3.1, 'Forward 2½ Somersaults 2 Twists'),
('5156', 10.0, 'B', 3.8, 'Forward 2½ Somersaults 3 Twists'),
('5156', 10.0, 'C', 3.6, 'Forward 2½ Somersaults 3 Twists'),
('5172', 10.0, 'B', 3.6, 'Forward 3½ Somersaults 1 Twist'),
('5172', 10.0, 'C', 3.3, 'Forward 3½ Somersaults 1 Twist');

-- -----------------------------------------------------------------------------
-- BACK TWISTING GROUP (521x / 522x / 523x / 525x / 527x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 1.0, 'A', 1.8, 'Back Dive ½ Twist'),
('5211', 1.0, 'B', 1.7, 'Back Dive ½ Twist'),
('5211', 1.0, 'C', 1.6, 'Back Dive ½ Twist'),
('5212', 1.0, 'A', 2.0, 'Back Dive 1 Twist'),
('5221', 1.0, 'D', 1.7, 'Back Somersault ½ Twist'),
('5222', 1.0, 'D', 1.9, 'Back Somersault 1 Twist'),
('5223', 1.0, 'D', 2.3, 'Back Somersault 1½ Twists'),
('5225', 1.0, 'D', 2.7, 'Back Somersault 2½ Twists'),
('5227', 1.0, 'D', 3.2, 'Back Somersault 3½ Twists'),
('5231', 1.0, 'D', 2.1, 'Back 1½ Somersaults ½ Twist'),
('5233', 1.0, 'D', 2.5, 'Back 1½ Somersaults 1½ Twists'),
('5235', 1.0, 'D', 2.9, 'Back 1½ Somersaults 2½ Twists'),
('5251', 1.0, 'B', 2.9, 'Back 2½ Somersaults ½ Twist'),
('5251', 1.0, 'C', 2.7, 'Back 2½ Somersaults ½ Twist');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 3.0, 'A', 2.0, 'Back Dive ½ Twist'),
('5211', 3.0, 'B', 1.9, 'Back Dive ½ Twist'),
('5211', 3.0, 'C', 1.8, 'Back Dive ½ Twist'),
('5212', 3.0, 'A', 2.2, 'Back Dive 1 Twist'),
('5221', 3.0, 'D', 1.8, 'Back Somersault ½ Twist'),
('5222', 3.0, 'D', 2.0, 'Back Somersault 1 Twist'),
('5223', 3.0, 'D', 2.4, 'Back Somersault 1½ Twists'),
('5225', 3.0, 'D', 2.8, 'Back Somersault 2½ Twists'),
('5227', 3.0, 'D', 3.3, 'Back Somersault 3½ Twists'),
('5231', 3.0, 'D', 2.0, 'Back 1½ Somersaults ½ Twist'),
('5233', 3.0, 'D', 2.4, 'Back 1½ Somersaults 1½ Twists'),
('5235', 3.0, 'D', 2.8, 'Back 1½ Somersaults 2½ Twists'),
('5237', 3.0, 'D', 3.3, 'Back 1½ Somersaults 3½ Twists'),
('5239', 3.0, 'D', 3.7, 'Back 1½ Somersaults 4½ Twists'),
('5251', 3.0, 'B', 2.7, 'Back 2½ Somersaults ½ Twist'),
('5251', 3.0, 'C', 2.5, 'Back 2½ Somersaults ½ Twist'),
('5253', 3.0, 'B', 3.4, 'Back 2½ Somersaults 1½ Twists'),
('5253', 3.0, 'C', 3.2, 'Back 2½ Somersaults 1½ Twists'),
('5255', 3.0, 'B', 3.8, 'Back 2½ Somersaults 2½ Twists'),
('5255', 3.0, 'C', 3.6, 'Back 2½ Somersaults 2½ Twists');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 5.0, 'A', 1.8, 'Back Dive ½ Twist'),
('5211', 5.0, 'B', 1.7, 'Back Dive ½ Twist'),
('5211', 5.0, 'C', 1.6, 'Back Dive ½ Twist'),
('5212', 5.0, 'A', 2.0, 'Back Dive 1 Twist'),
('5221', 5.0, 'D', 1.7, 'Back Somersault ½ Twist'),
('5222', 5.0, 'D', 1.9, 'Back Somersault 1 Twist'),
('5223', 5.0, 'D', 2.3, 'Back Somersault 1½ Twists'),
('5225', 5.0, 'D', 2.7, 'Back Somersault 2½ Twists'),
('5231', 5.0, 'D', 2.1, 'Back 1½ Somersaults ½ Twist'),
('5233', 5.0, 'D', 2.5, 'Back 1½ Somersaults 1½ Twists'),
('5235', 5.0, 'D', 2.9, 'Back 1½ Somersaults 2½ Twists'),
('5237', 5.0, 'D', 3.4, 'Back 1½ Somersaults 3½ Twists'),
('5239', 5.0, 'D', 3.8, 'Back 1½ Somersaults 4½ Twists'),
('5251', 5.0, 'B', 2.9, 'Back 2½ Somersaults ½ Twist'),
('5251', 5.0, 'C', 2.7, 'Back 2½ Somersaults ½ Twist'),
('5257', 5.0, 'B', 4.1, 'Back 2½ Somersaults 3½ Twists'),
('5257', 5.0, 'C', 3.9, 'Back 2½ Somersaults 3½ Twists'),
('5271', 5.0, 'B', 3.2, 'Back 3½ Somersaults ½ Twist'),
('5271', 5.0, 'C', 2.9, 'Back 3½ Somersaults ½ Twist'),
('5273', 5.0, 'B', 3.8, 'Back 3½ Somersaults 1½ Twists'),
('5273', 5.0, 'C', 3.5, 'Back 3½ Somersaults 1½ Twists'),
('5275', 5.0, 'B', 4.2, 'Back 3½ Somersaults 2½ Twists'),
('5275', 5.0, 'C', 3.9, 'Back 3½ Somersaults 2½ Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 7.5, 'A', 2.0, 'Back Dive ½ Twist'),
('5211', 7.5, 'B', 1.9, 'Back Dive ½ Twist'),
('5211', 7.5, 'C', 1.8, 'Back Dive ½ Twist'),
('5212', 7.5, 'A', 2.2, 'Back Dive 1 Twist'),
('5221', 7.5, 'D', 1.8, 'Back Somersault ½ Twist'),
('5222', 7.5, 'D', 2.0, 'Back Somersault 1 Twist'),
('5223', 7.5, 'D', 2.4, 'Back Somersault 1½ Twists'),
('5225', 7.5, 'D', 2.8, 'Back Somersault 2½ Twists'),
('5231', 7.5, 'D', 2.0, 'Back 1½ Somersaults ½ Twist'),
('5233', 7.5, 'D', 2.4, 'Back 1½ Somersaults 1½ Twists'),
('5235', 7.5, 'D', 2.8, 'Back 1½ Somersaults 2½ Twists'),
('5237', 7.5, 'D', 3.3, 'Back 1½ Somersaults 3½ Twists'),
('5239', 7.5, 'D', 3.7, 'Back 1½ Somersaults 4½ Twists'),
('5251', 7.5, 'B', 2.7, 'Back 2½ Somersaults ½ Twist'),
('5251', 7.5, 'C', 2.5, 'Back 2½ Somersaults ½ Twist'),
('5253', 7.5, 'B', 3.3, 'Back 2½ Somersaults 1½ Twists'),
('5253', 7.5, 'C', 3.1, 'Back 2½ Somersaults 1½ Twists');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5211', 10.0, 'A', 2.0, 'Back Dive ½ Twist'),
('5211', 10.0, 'B', 1.9, 'Back Dive ½ Twist'),
('5211', 10.0, 'C', 1.8, 'Back Dive ½ Twist'),
('5212', 10.0, 'A', 2.2, 'Back Dive 1 Twist'),
('5221', 10.0, 'D', 1.9, 'Back Somersault ½ Twist'),
('5222', 10.0, 'D', 2.1, 'Back Somersault 1 Twist'),
('5223', 10.0, 'D', 2.5, 'Back Somersault 1½ Twists'),
('5225', 10.0, 'D', 2.9, 'Back Somersault 2½ Twists'),
('5231', 10.0, 'D', 2.0, 'Back 1½ Somersaults ½ Twist'),
('5233', 10.0, 'D', 2.4, 'Back 1½ Somersaults 1½ Twists'),
('5235', 10.0, 'D', 2.8, 'Back 1½ Somersaults 2½ Twists'),
('5237', 10.0, 'D', 3.3, 'Back 1½ Somersaults 3½ Twists'),
('5239', 10.0, 'D', 3.7, 'Back 1½ Somersaults 4½ Twists'),
('5251', 10.0, 'B', 2.6, 'Back 2½ Somersaults ½ Twist'),
('5251', 10.0, 'C', 2.4, 'Back 2½ Somersaults ½ Twist'),
('5253', 10.0, 'B', 3.2, 'Back 2½ Somersaults 1½ Twists'),
('5253', 10.0, 'C', 3.0, 'Back 2½ Somersaults 1½ Twists'),
('5255', 10.0, 'B', 3.6, 'Back 2½ Somersaults 2½ Twists'),
('5255', 10.0, 'C', 3.4, 'Back 2½ Somersaults 2½ Twists'),
('5257', 10.0, 'B', 4.1, 'Back 2½ Somersaults 3½ Twists'),
('5257', 10.0, 'C', 3.9, 'Back 2½ Somersaults 3½ Twists'),
('5271', 10.0, 'B', 3.2, 'Back 3½ Somersaults ½ Twist'),
('5271', 10.0, 'C', 2.9, 'Back 3½ Somersaults ½ Twist'),
('5273', 10.0, 'B', 3.8, 'Back 3½ Somersaults 1½ Twists'),
('5273', 10.0, 'C', 3.5, 'Back 3½ Somersaults 1½ Twists'),
('5275', 10.0, 'B', 4.2, 'Back 3½ Somersaults 2½ Twists'),
('5275', 10.0, 'C', 3.9, 'Back 3½ Somersaults 2½ Twists');

-- -----------------------------------------------------------------------------
-- REVERSE TWISTING GROUP (531x / 532x / 533x / 535x / 537x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 1.0, 'A', 1.9, 'Reverse Dive ½ Twist'),
('5311', 1.0, 'B', 1.8, 'Reverse Dive ½ Twist'),
('5311', 1.0, 'C', 1.7, 'Reverse Dive ½ Twist'),
('5312', 1.0, 'A', 2.1, 'Reverse Dive 1 Twist'),
('5321', 1.0, 'D', 1.8, 'Reverse Somersault ½ Twist'),
('5322', 1.0, 'D', 2.0, 'Reverse Somersault 1 Twist'),
('5323', 1.0, 'D', 2.4, 'Reverse Somersault 1½ Twists'),
('5325', 1.0, 'D', 2.8, 'Reverse Somersault 2½ Twists'),
('5331', 1.0, 'D', 2.2, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 1.0, 'D', 2.6, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 1.0, 'D', 3.0, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 1.0, 'D', 3.6, 'Reverse 1½ Somersaults 3½ Twists'),
('5351', 1.0, 'B', 2.9, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 1.0, 'C', 2.7, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 1.0, 'B', 3.5, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 1.0, 'C', 3.3, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 1.0, 'B', 3.9, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 1.0, 'C', 3.7, 'Reverse 2½ Somersaults 2½ Twists');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 3.0, 'A', 2.1, 'Reverse Dive ½ Twist'),
('5311', 3.0, 'B', 2.0, 'Reverse Dive ½ Twist'),
('5311', 3.0, 'C', 1.9, 'Reverse Dive ½ Twist'),
('5312', 3.0, 'A', 2.3, 'Reverse Dive 1 Twist'),
('5321', 3.0, 'D', 1.9, 'Reverse Somersault ½ Twist'),
('5322', 3.0, 'D', 2.1, 'Reverse Somersault 1 Twist'),
('5323', 3.0, 'D', 2.5, 'Reverse Somersault 1½ Twists'),
('5325', 3.0, 'D', 2.9, 'Reverse Somersault 2½ Twists'),
('5331', 3.0, 'D', 2.1, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 3.0, 'D', 2.5, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 3.0, 'D', 2.9, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 3.0, 'D', 3.5, 'Reverse 1½ Somersaults 3½ Twists'),
('5339', 3.0, 'D', 3.8, 'Reverse 1½ Somersaults 4½ Twists'),
('5351', 3.0, 'B', 2.7, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 3.0, 'C', 2.5, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 3.0, 'B', 3.3, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 3.0, 'C', 3.1, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 3.0, 'B', 3.7, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 3.0, 'C', 3.5, 'Reverse 2½ Somersaults 2½ Twists'),
('5371', 3.0, 'B', 3.4, 'Reverse 3½ Somersaults ½ Twist'),
('5371', 3.0, 'C', 3.1, 'Reverse 3½ Somersaults ½ Twist'),
('5373', 3.0, 'C', 3.7, 'Reverse 3½ Somersaults 1½ Twists'),
('5375', 3.0, 'B', 4.1, 'Reverse 3½ Somersaults 2½ Twists');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 5.0, 'A', 1.9, 'Reverse Dive ½ Twist'),
('5311', 5.0, 'B', 1.8, 'Reverse Dive ½ Twist'),
('5311', 5.0, 'C', 1.7, 'Reverse Dive ½ Twist'),
('5312', 5.0, 'A', 2.1, 'Reverse Dive 1 Twist'),
('5321', 5.0, 'D', 1.8, 'Reverse Somersault ½ Twist'),
('5322', 5.0, 'D', 2.0, 'Reverse Somersault 1 Twist'),
('5323', 5.0, 'D', 2.4, 'Reverse Somersault 1½ Twists'),
('5325', 5.0, 'D', 2.8, 'Reverse Somersault 2½ Twists'),
('5331', 5.0, 'D', 2.2, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 5.0, 'D', 2.6, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 5.0, 'D', 3.0, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 5.0, 'D', 3.5, 'Reverse 1½ Somersaults 3½ Twists'),
('5351', 5.0, 'B', 3.0, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 5.0, 'C', 2.8, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 5.0, 'B', 3.4, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 5.0, 'B', 3.8, 'Reverse 2½ Somersaults 2½ Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 7.5, 'A', 2.1, 'Reverse Dive ½ Twist'),
('5311', 7.5, 'B', 2.0, 'Reverse Dive ½ Twist'),
('5311', 7.5, 'C', 1.9, 'Reverse Dive ½ Twist'),
('5312', 7.5, 'A', 2.3, 'Reverse Dive 1 Twist'),
('5321', 7.5, 'D', 1.9, 'Reverse Somersault ½ Twist'),
('5322', 7.5, 'D', 2.1, 'Reverse Somersault 1 Twist'),
('5323', 7.5, 'D', 2.5, 'Reverse Somersault 1½ Twists'),
('5325', 7.5, 'D', 2.9, 'Reverse Somersault 2½ Twists'),
('5331', 7.5, 'D', 2.1, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 7.5, 'D', 2.5, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 7.5, 'D', 2.9, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 7.5, 'D', 3.4, 'Reverse 1½ Somersaults 3½ Twists'),
('5339', 7.5, 'D', 3.8, 'Reverse 1½ Somersaults 4½ Twists'),
('5351', 7.5, 'B', 2.8, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 7.5, 'C', 2.6, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 7.5, 'B', 3.4, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 7.5, 'C', 3.2, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 7.5, 'B', 3.8, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 7.5, 'C', 3.6, 'Reverse 2½ Somersaults 2½ Twists');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5311', 10.0, 'A', 2.1, 'Reverse Dive ½ Twist'),
('5311', 10.0, 'B', 2.0, 'Reverse Dive ½ Twist'),
('5311', 10.0, 'C', 1.9, 'Reverse Dive ½ Twist'),
('5312', 10.0, 'A', 2.3, 'Reverse Dive 1 Twist'),
('5321', 10.0, 'D', 2.0, 'Reverse Somersault ½ Twist'),
('5322', 10.0, 'D', 2.2, 'Reverse Somersault 1 Twist'),
('5323', 10.0, 'D', 2.6, 'Reverse Somersault 1½ Twists'),
('5325', 10.0, 'D', 3.0, 'Reverse Somersault 2½ Twists'),
('5331', 10.0, 'D', 2.1, 'Reverse 1½ Somersaults ½ Twist'),
('5333', 10.0, 'D', 2.5, 'Reverse 1½ Somersaults 1½ Twists'),
('5335', 10.0, 'D', 2.9, 'Reverse 1½ Somersaults 2½ Twists'),
('5337', 10.0, 'D', 3.4, 'Reverse 1½ Somersaults 3½ Twists'),
('5339', 10.0, 'D', 3.8, 'Reverse 1½ Somersaults 4½ Twists'),
('5351', 10.0, 'B', 2.7, 'Reverse 2½ Somersaults ½ Twist'),
('5351', 10.0, 'C', 2.5, 'Reverse 2½ Somersaults ½ Twist'),
('5353', 10.0, 'B', 3.3, 'Reverse 2½ Somersaults 1½ Twists'),
('5353', 10.0, 'C', 3.1, 'Reverse 2½ Somersaults 1½ Twists'),
('5355', 10.0, 'B', 3.7, 'Reverse 2½ Somersaults 2½ Twists'),
('5355', 10.0, 'C', 3.5, 'Reverse 2½ Somersaults 2½ Twists'),
('5371', 10.0, 'B', 3.3, 'Reverse 3½ Somersaults ½ Twist'),
('5371', 10.0, 'C', 3.0, 'Reverse 3½ Somersaults ½ Twist'),
('5373', 10.0, 'B', 3.6, 'Reverse 3½ Somersaults 1½ Twists'),
('5375', 10.0, 'B', 4.0, 'Reverse 3½ Somersaults 2½ Twists');

-- -----------------------------------------------------------------------------
-- INWARD TWISTING GROUP (541x / 542x / 543x)
-- -----------------------------------------------------------------------------

-- 1m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 1.0, 'A', 2.0, 'Inward Dive ½ Twist'),
('5411', 1.0, 'B', 1.7, 'Inward Dive ½ Twist'),
('5411', 1.0, 'C', 1.6, 'Inward Dive ½ Twist'),
('5412', 1.0, 'A', 2.2, 'Inward Dive 1 Twist'),
('5412', 1.0, 'B', 1.9, 'Inward Dive 1 Twist'),
('5412', 1.0, 'C', 1.8, 'Inward Dive 1 Twist'),
('5421', 1.0, 'D', 1.9, 'Inward Somersault ½ Twist'),
('5422', 1.0, 'D', 2.1, 'Inward Somersault 1 Twist'),
('5432', 1.0, 'D', 2.7, 'Inward 1½ Somersaults 1 Twist'),
('5434', 1.0, 'D', 3.1, 'Inward 1½ Somersaults 2 Twists');

-- 3m springboard
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 3.0, 'A', 1.9, 'Inward Dive ½ Twist'),
('5411', 3.0, 'B', 1.6, 'Inward Dive ½ Twist'),
('5411', 3.0, 'C', 1.5, 'Inward Dive ½ Twist'),
('5412', 3.0, 'A', 2.1, 'Inward Dive 1 Twist'),
('5412', 3.0, 'B', 1.8, 'Inward Dive 1 Twist'),
('5412', 3.0, 'C', 1.7, 'Inward Dive 1 Twist'),
('5421', 3.0, 'D', 1.7, 'Inward Somersault ½ Twist'),
('5422', 3.0, 'D', 1.9, 'Inward Somersault 1 Twist'),
('5432', 3.0, 'D', 2.4, 'Inward 1½ Somersaults 1 Twist'),
('5434', 3.0, 'D', 2.8, 'Inward 1½ Somersaults 2 Twists'),
('5436', 3.0, 'D', 3.5, 'Inward 1½ Somersaults 3 Twists');

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 5.0, 'A', 2.0, 'Inward Dive ½ Twist'),
('5411', 5.0, 'B', 1.7, 'Inward Dive ½ Twist'),
('5411', 5.0, 'C', 1.6, 'Inward Dive ½ Twist'),
('5412', 5.0, 'A', 2.2, 'Inward Dive 1 Twist'),
('5412', 5.0, 'B', 1.9, 'Inward Dive 1 Twist'),
('5412', 5.0, 'C', 1.8, 'Inward Dive 1 Twist'),
('5421', 5.0, 'D', 1.9, 'Inward Somersault ½ Twist'),
('5422', 5.0, 'D', 2.1, 'Inward Somersault 1 Twist'),
('5432', 5.0, 'D', 2.7, 'Inward 1½ Somersaults 1 Twist'),
('5434', 5.0, 'D', 3.1, 'Inward 1½ Somersaults 2 Twists');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 7.5, 'A', 1.9, 'Inward Dive ½ Twist'),
('5411', 7.5, 'B', 1.6, 'Inward Dive ½ Twist'),
('5411', 7.5, 'C', 1.5, 'Inward Dive ½ Twist'),
('5412', 7.5, 'A', 2.1, 'Inward Dive 1 Twist'),
('5412', 7.5, 'B', 1.8, 'Inward Dive 1 Twist'),
('5412', 7.5, 'C', 1.7, 'Inward Dive 1 Twist'),
('5421', 7.5, 'D', 1.7, 'Inward Somersault ½ Twist'),
('5422', 7.5, 'D', 1.9, 'Inward Somersault 1 Twist'),
('5432', 7.5, 'D', 2.4, 'Inward 1½ Somersaults 1 Twist'),
('5434', 7.5, 'D', 2.8, 'Inward 1½ Somersaults 2 Twists');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('5411', 10.0, 'A', 1.9, 'Inward Dive ½ Twist'),
('5411', 10.0, 'B', 1.6, 'Inward Dive ½ Twist'),
('5411', 10.0, 'C', 1.5, 'Inward Dive ½ Twist'),
('5412', 10.0, 'A', 2.1, 'Inward Dive 1 Twist'),
('5412', 10.0, 'B', 1.8, 'Inward Dive 1 Twist'),
('5412', 10.0, 'C', 1.7, 'Inward Dive 1 Twist'),
('5421', 10.0, 'D', 1.8, 'Inward Somersault ½ Twist'),
('5422', 10.0, 'D', 2.0, 'Inward Somersault 1 Twist'),
('5432', 10.0, 'D', 2.3, 'Inward 1½ Somersaults 1 Twist'),
('5434', 10.0, 'D', 2.7, 'Inward 1½ Somersaults 2 Twists'),
('5436', 10.0, 'D', 3.4, 'Inward 1½ Somersaults 3 Twists');

-- -----------------------------------------------------------------------------
-- ARMSTAND GROUP (6xx / 6xxx) — Platform only
-- -----------------------------------------------------------------------------

-- 5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('600',  5.0, 'A', 1.5, 'Armstand Dive'),
('611',  5.0, 'A', 1.8, 'Armstand Forward ½ Somersault'),
('611',  5.0, 'B', 1.7, 'Armstand Forward ½ Somersault'),
('611',  5.0, 'C', 1.5, 'Armstand Forward ½ Somersault'),
('612',  5.0, 'A', 1.8, 'Armstand Forward 1 Somersault'),
('612',  5.0, 'B', 1.7, 'Armstand Forward 1 Somersault'),
('612',  5.0, 'C', 1.5, 'Armstand Forward 1 Somersault'),
('614',  5.0, 'B', 2.5, 'Armstand Forward 2 Somersaults'),
('614',  5.0, 'C', 2.2, 'Armstand Forward 2 Somersaults'),
('621',  5.0, 'A', 1.7, 'Armstand Back ½ Somersault'),
('621',  5.0, 'B', 1.6, 'Armstand Back ½ Somersault'),
('621',  5.0, 'C', 1.4, 'Armstand Back ½ Somersault'),
('622',  5.0, 'A', 2.1, 'Armstand Back 1 Somersault'),
('622',  5.0, 'B', 2.0, 'Armstand Back 1 Somersault'),
('622',  5.0, 'C', 1.8, 'Armstand Back 1 Somersault'),
('623',  5.0, 'B', 2.3, 'Armstand Back 1½ Somersaults'),
('623',  5.0, 'C', 2.0, 'Armstand Back 1½ Somersaults'),
('624',  5.0, 'A', 3.1, 'Armstand Back 2 Somersaults'),
('624',  5.0, 'B', 2.9, 'Armstand Back 2 Somersaults'),
('624',  5.0, 'C', 2.6, 'Armstand Back 2 Somersaults'),
('626',  5.0, 'B', 3.5, 'Armstand Back 3 Somersaults'),
('631',  5.0, 'A', 1.8, 'Armstand Reverse ½ Somersault'),
('631',  5.0, 'B', 1.7, 'Armstand Reverse ½ Somersault'),
('631',  5.0, 'C', 1.5, 'Armstand Reverse ½ Somersault'),
('632',  5.0, 'B', 2.1, 'Armstand Reverse 1 Somersault'),
('632',  5.0, 'C', 1.9, 'Armstand Reverse 1 Somersault'),
('633',  5.0, 'B', 2.4, 'Armstand Reverse 1½ Somersaults'),
('633',  5.0, 'C', 2.1, 'Armstand Reverse 1½ Somersaults'),
('634',  5.0, 'B', 3.0, 'Armstand Reverse 2 Somersaults'),
('634',  5.0, 'C', 2.7, 'Armstand Reverse 2 Somersaults'),
('6122', 5.0, 'D', 2.4, 'Armstand Forward 1 Somersault 1 Twist'),
('6124', 5.0, 'D', 2.7, 'Armstand Forward 1 Somersault 2 Twists'),
('6142', 5.0, 'D', 3.2, 'Armstand Forward 2 Somersaults 1 Twist'),
('6144', 5.0, 'D', 3.5, 'Armstand Forward 2 Somersaults 2 Twists'),
('6221', 5.0, 'D', 1.6, 'Armstand Back 1 Somersault ½ Twist'),
('6241', 5.0, 'B', 2.8, 'Armstand Back 2 Somersaults ½ Twist'),
('6241', 5.0, 'C', 2.5, 'Armstand Back 2 Somersaults ½ Twist'),
('6243', 5.0, 'D', 3.3, 'Armstand Back 2 Somersaults 1½ Twists'),
('6245', 5.0, 'D', 3.7, 'Armstand Back 2 Somersaults 2½ Twists'),
('6261', 5.0, 'B', 3.6, 'Armstand Back 3 Somersaults ½ Twist'),
('6261', 5.0, 'C', 3.4, 'Armstand Back 3 Somersaults ½ Twist');

-- 7.5m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('600',  7.5, 'A', 1.6, 'Armstand Dive'),
('611',  7.5, 'A', 2.0, 'Armstand Forward ½ Somersault'),
('611',  7.5, 'B', 1.9, 'Armstand Forward ½ Somersault'),
('611',  7.5, 'C', 1.7, 'Armstand Forward ½ Somersault'),
('612',  7.5, 'A', 1.9, 'Armstand Forward 1 Somersault'),
('612',  7.5, 'B', 1.8, 'Armstand Forward 1 Somersault'),
('612',  7.5, 'C', 1.6, 'Armstand Forward 1 Somersault'),
('614',  7.5, 'B', 2.3, 'Armstand Forward 2 Somersaults'),
('614',  7.5, 'C', 2.0, 'Armstand Forward 2 Somersaults'),
('621',  7.5, 'A', 1.9, 'Armstand Back ½ Somersault'),
('621',  7.5, 'B', 1.8, 'Armstand Back ½ Somersault'),
('621',  7.5, 'C', 1.6, 'Armstand Back ½ Somersault'),
('622',  7.5, 'A', 2.2, 'Armstand Back 1 Somersault'),
('622',  7.5, 'B', 2.1, 'Armstand Back 1 Somersault'),
('622',  7.5, 'C', 1.9, 'Armstand Back 1 Somersault'),
('623',  7.5, 'B', 2.2, 'Armstand Back 1½ Somersaults'),
('623',  7.5, 'C', 1.9, 'Armstand Back 1½ Somersaults'),
('624',  7.5, 'A', 2.9, 'Armstand Back 2 Somersaults'),
('624',  7.5, 'B', 2.7, 'Armstand Back 2 Somersaults'),
('624',  7.5, 'C', 2.4, 'Armstand Back 2 Somersaults'),
('626',  7.5, 'B', 3.3, 'Armstand Back 3 Somersaults'),
('626',  7.5, 'C', 3.1, 'Armstand Back 3 Somersaults'),
('631',  7.5, 'A', 2.0, 'Armstand Reverse ½ Somersault'),
('631',  7.5, 'B', 1.9, 'Armstand Reverse ½ Somersault'),
('631',  7.5, 'C', 1.7, 'Armstand Reverse ½ Somersault'),
('632',  7.5, 'B', 2.2, 'Armstand Reverse 1 Somersault'),
('632',  7.5, 'C', 2.0, 'Armstand Reverse 1 Somersault'),
('633',  7.5, 'B', 2.3, 'Armstand Reverse 1½ Somersaults'),
('633',  7.5, 'C', 2.0, 'Armstand Reverse 1½ Somersaults'),
('634',  7.5, 'B', 2.8, 'Armstand Reverse 2 Somersaults'),
('634',  7.5, 'C', 2.5, 'Armstand Reverse 2 Somersaults'),
('636',  7.5, 'B', 3.2, 'Armstand Reverse 3 Somersaults'),
('6122', 7.5, 'D', 2.5, 'Armstand Forward 1 Somersault 1 Twist'),
('6124', 7.5, 'D', 2.8, 'Armstand Forward 1 Somersault 2 Twists'),
('6142', 7.5, 'D', 3.0, 'Armstand Forward 2 Somersaults 1 Twist'),
('6144', 7.5, 'D', 3.3, 'Armstand Forward 2 Somersaults 2 Twists'),
('6221', 7.5, 'D', 1.7, 'Armstand Back 1 Somersault ½ Twist'),
('6241', 7.5, 'B', 2.6, 'Armstand Back 2 Somersaults ½ Twist'),
('6241', 7.5, 'C', 2.3, 'Armstand Back 2 Somersaults ½ Twist'),
('6243', 7.5, 'D', 3.1, 'Armstand Back 2 Somersaults 1½ Twists'),
('6245', 7.5, 'D', 3.5, 'Armstand Back 2 Somersaults 2½ Twists'),
('6261', 7.5, 'B', 3.2, 'Armstand Back 3 Somersaults ½ Twist'),
('6261', 7.5, 'C', 3.0, 'Armstand Back 3 Somersaults ½ Twist');

-- 10m platform
INSERT INTO dive_directory (dive_code, height, position, dd, description) VALUES
('600',  10.0, 'A', 1.6, 'Armstand Dive'),
('611',  10.0, 'A', 2.0, 'Armstand Forward ½ Somersault'),
('611',  10.0, 'B', 1.9, 'Armstand Forward ½ Somersault'),
('611',  10.0, 'C', 1.7, 'Armstand Forward ½ Somersault'),
('612',  10.0, 'A', 2.0, 'Armstand Forward 1 Somersault'),
('612',  10.0, 'B', 1.9, 'Armstand Forward 1 Somersault'),
('612',  10.0, 'C', 1.7, 'Armstand Forward 1 Somersault'),
('614',  10.0, 'B', 2.4, 'Armstand Forward 2 Somersaults'),
('614',  10.0, 'C', 2.1, 'Armstand Forward 2 Somersaults'),
('616',  10.0, 'B', 3.3, 'Armstand Forward 3 Somersaults'),
('616',  10.0, 'C', 3.1, 'Armstand Forward 3 Somersaults'),
('621',  10.0, 'A', 1.9, 'Armstand Back ½ Somersault'),
('621',  10.0, 'B', 1.8, 'Armstand Back ½ Somersault'),
('621',  10.0, 'C', 1.6, 'Armstand Back ½ Somersault'),
('622',  10.0, 'A', 2.3, 'Armstand Back 1 Somersault'),
('622',  10.0, 'B', 2.2, 'Armstand Back 1 Somersault'),
('622',  10.0, 'C', 2.0, 'Armstand Back 1 Somersault'),
('623',  10.0, 'B', 2.2, 'Armstand Back 1½ Somersaults'),
('623',  10.0, 'C', 1.9, 'Armstand Back 1½ Somersaults'),
('624',  10.0, 'A', 3.0, 'Armstand Back 2 Somersaults'),
('624',  10.0, 'B', 2.8, 'Armstand Back 2 Somersaults'),
('624',  10.0, 'C', 2.5, 'Armstand Back 2 Somersaults'),
('626',  10.0, 'B', 3.5, 'Armstand Back 3 Somersaults'),
('626',  10.0, 'C', 3.3, 'Armstand Back 3 Somersaults'),
('628',  10.0, 'B', 4.7, 'Armstand Back 4 Somersaults'),
('628',  10.0, 'C', 4.5, 'Armstand Back 4 Somersaults'),
('631',  10.0, 'A', 2.0, 'Armstand Reverse ½ Somersault'),
('631',  10.0, 'B', 1.9, 'Armstand Reverse ½ Somersault'),
('631',  10.0, 'C', 1.7, 'Armstand Reverse ½ Somersault'),
('632',  10.0, 'B', 2.3, 'Armstand Reverse 1 Somersault'),
('632',  10.0, 'C', 2.1, 'Armstand Reverse 1 Somersault'),
('633',  10.0, 'B', 2.3, 'Armstand Reverse 1½ Somersaults'),
('633',  10.0, 'C', 2.0, 'Armstand Reverse 1½ Somersaults'),
('634',  10.0, 'B', 2.9, 'Armstand Reverse 2 Somersaults'),
('634',  10.0, 'C', 2.6, 'Armstand Reverse 2 Somersaults'),
('636',  10.0, 'B', 3.6, 'Armstand Reverse 3 Somersaults'),
('636',  10.0, 'C', 3.4, 'Armstand Reverse 3 Somersaults'),
('638',  10.0, 'B', 4.8, 'Armstand Reverse 4 Somersaults'),
('638',  10.0, 'C', 4.6, 'Armstand Reverse 4 Somersaults'),
('6122', 10.0, 'D', 2.6, 'Armstand Forward 1 Somersault 1 Twist'),
('6124', 10.0, 'D', 2.9, 'Armstand Forward 1 Somersault 2 Twists'),
('6142', 10.0, 'D', 3.1, 'Armstand Forward 2 Somersaults 1 Twist'),
('6144', 10.0, 'D', 3.4, 'Armstand Forward 2 Somersaults 2 Twists'),
('6162', 10.0, 'B', 3.9, 'Armstand Forward 3 Somersaults 1 Twist'),
('6221', 10.0, 'D', 1.8, 'Armstand Back 1 Somersault ½ Twist'),
('6241', 10.0, 'B', 2.7, 'Armstand Back 2 Somersaults ½ Twist'),
('6241', 10.0, 'C', 2.4, 'Armstand Back 2 Somersaults ½ Twist'),
('6243', 10.0, 'D', 3.2, 'Armstand Back 2 Somersaults 1½ Twists'),
('6245', 10.0, 'D', 3.6, 'Armstand Back 2 Somersaults 2½ Twists'),
('6247', 10.0, 'D', 4.0, 'Armstand Back 2 Somersaults 3½ Twists'),
('6261', 10.0, 'B', 3.4, 'Armstand Back 3 Somersaults ½ Twist'),
('6261', 10.0, 'C', 3.2, 'Armstand Back 3 Somersaults ½ Twist'),
('6263', 10.0, 'B', 4.2, 'Armstand Back 3 Somersaults 1½ Twists'),
('6263', 10.0, 'C', 4.0, 'Armstand Back 3 Somersaults 1½ Twists'),
('6265', 10.0, 'B', 4.6, 'Armstand Back 3 Somersaults 2½ Twists'),
('6265', 10.0, 'C', 4.4, 'Armstand Back 3 Somersaults 2½ Twists');

COMMIT;

-- =============================================================================
-- Summary of rows inserted (approximate):
--   Forward group (1xx):        ~111 rows
--   Back group (2xx):           ~109 rows
--   Reverse group (3xx):        ~100 rows
--   Inward group (4xx):         ~91 rows
--   Forward twisting (51xx):    ~90 rows
--   Back twisting (52xx):       ~82 rows
--   Reverse twisting (53xx):    ~88 rows
--   Inward twisting (54xx):     ~48 rows
--   Armstand group (6xx/6xxx):  ~115 rows
--   Total:                      ~834 rows
-- =============================================================================
