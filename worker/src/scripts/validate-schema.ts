/**
 * Schema Validation Script
 * 
 * Validates that SQL INSERT/UPDATE statements match the actual schema.
 * Run this before deploying to catch column count mismatches.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

function parseSchema(sql: string): Map<string, ColumnInfo[]> {
  const tables = new Map<string, ColumnInfo[]>();
  const lines = sql.split('\n');
  let currentTable: string | null = null;
  let columns: ColumnInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Match CREATE TABLE
    const tableMatch = trimmed.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
    if (tableMatch) {
      if (currentTable && columns.length > 0) {
        tables.set(currentTable, columns);
      }
      currentTable = tableMatch[1];
      columns = [];
      continue;
    }

    // Match column definition
    if (currentTable && trimmed && !trimmed.startsWith('--') && !trimmed.startsWith('(') && !trimmed.startsWith(')')) {
      const colMatch = trimmed.match(/^(\w+)\s+(\w+)/);
      if (colMatch) {
        const name = colMatch[1];
        const type = colMatch[2];
        const nullable = !trimmed.includes('NOT NULL');
        columns.push({ name, type, nullable });
      }
    }

    // End of table
    if (trimmed === ');' && currentTable) {
      if (columns.length > 0) {
        tables.set(currentTable, columns);
      }
      currentTable = null;
      columns = [];
    }
  }

  if (currentTable && columns.length > 0) {
    tables.set(currentTable, columns);
  }

  return tables;
}

function extractInsertStatements(tsFile: string): Map<string, { columns: string[]; placeholders: number }> {
  const inserts = new Map<string, { columns: string[]; placeholders: number }>();
  
  // Match INSERT INTO table_name (col1, col2, ...) VALUES (?, ?, ...)
  const insertRegex = /INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi;
  let match;
  
  while ((match = insertRegex.exec(tsFile)) !== null) {
    const tableName = match[1];
    const columnsStr = match[2];
    const valuesStr = match[3];
    
    const columns = columnsStr.split(',').map(c => c.trim());
    const placeholders = (valuesStr.match(/\?/g) || []).length;
    
    inserts.set(tableName, { columns, placeholders });
  }
  
  return inserts;
}

function validateSchema() {
  const schemaPath = join(__dirname, '../db/schema.sql');
  const queriesPath = join(__dirname, '../db/queries.ts');
  
  console.log('🔍 Validating schema consistency...\n');
  
  const schema = readFileSync(schemaPath, 'utf-8');
  const queries = readFileSync(queriesPath, 'utf-8');
  
  const tables = parseSchema(schema);
  const inserts = extractInsertStatements(queries);
  
  let errors = 0;
  
  for (const [tableName, insertInfo] of inserts.entries()) {
    const tableColumns = tables.get(tableName);
    
    if (!tableColumns) {
      console.error(`❌ Table "${tableName}" not found in schema`);
      errors++;
      continue;
    }
    
    const expectedColumns = tableColumns.length;
    const actualColumns = insertInfo.columns.length;
    const actualPlaceholders = insertInfo.placeholders;
    
    if (actualColumns !== expectedColumns) {
      console.error(`❌ Table "${tableName}":`);
      console.error(`   Schema has ${expectedColumns} columns, INSERT has ${actualColumns} columns`);
      errors++;
    }
    
    if (actualPlaceholders !== expectedColumns) {
      console.error(`❌ Table "${tableName}":`);
      console.error(`   Schema has ${expectedColumns} columns, VALUES has ${actualPlaceholders} placeholders`);
      errors++;
    }
    
    // Check for missing columns
    const schemaColumnNames = new Set(tableColumns.map(c => c.name));
    const insertColumnNames = new Set(insertInfo.columns);
    
    for (const col of schemaColumnNames) {
      if (!insertColumnNames.has(col)) {
        console.error(`❌ Table "${tableName}": Missing column "${col}" in INSERT statement`);
        errors++;
      }
    }
    
    if (errors === 0) {
      console.log(`✅ Table "${tableName}": ${expectedColumns} columns, ${actualPlaceholders} placeholders - OK`);
    }
  }
  
  if (errors > 0) {
    console.error(`\n❌ Found ${errors} validation error(s). Fix before deploying!`);
    process.exit(1);
  } else {
    console.log('\n✅ All schema validations passed!');
  }
}

validateSchema();

