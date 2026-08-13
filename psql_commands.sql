-- ============================================
-- psql Meta-Commands Reference
-- Only work in psql interactive terminal, NOT in SQL scripts or other clients
-- ============================================

-- Database
\l -- list all databases
\l+ -- list databases with details (size, owner, encoding)
\c dbname -- connect to database
\c dbname username -- connect to database with a specific user

-- Schema
\dn -- list schemas
\dn+ -- list schemas with details

-- Tables
\dt -- list tables
\dt+ -- list tables with details (size, description)
\dt schema.* -- list tables in specific schema
\d table_name -- describe table structure
\d+ table_name -- describe table with details (size, indexes, storage)

-- Indexes
\di -- list indexes
\di+ -- list indexes with details
\di schema.* -- list indexes in specific schema

-- Sequences
\ds -- list sequences
\ds+ -- list sequences with details

-- Views
\dv -- list views
\dv+ -- list views with details

-- Functions
\df -- list functions
\df+ -- list functions with details
\sf function_name -- show function source definition

-- Types
\dT -- list data types
\dT+ -- list data types with details
\du -- list roles with memberships

-- Extensions
\dx -- list installed extensions
\dx+ -- list installed extensions with details

-- Output Formatting
\pset format unaligned -- set output format
\pset border 2 -- show borders between cells
\pset columns N -- set display width
\pset pager off -- disable pager for long output
\t -- toggle tuples-only (hide row count)
\x -- toggle expanded display (vertical)

-- File Operations
\i filename.sql -- execute SQL file
\o filename -- send output to file
\o -- send output back to stdout
\q -- quit psql
\! command -- execute shell command

-- Timing and Help
\timing -- toggle query timing
\? -- show all meta-commands
\help command -- help for SQL command
\h command -- short help for SQL command
