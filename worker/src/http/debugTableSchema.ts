/**
 * Debug Table Schema Endpoint
 * 
 * Query the actual D1 database schema to see table structure.
 * 
 * GET /v2/debug/table-schema?table=trades
 */

import type { Env } from '../env';
import { getDB } from '../db/client';

interface TableSchemaResult {
  timestamp: string;
  table: string;
  schema: string;
  sample_row?: any;
  columns: Array<{
    name: string;
    type: string;
    not_null: boolean;
    default_value: string | null;
  }>;
}

export async function handleDebugTableSchema(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tableName = url.searchParams.get('table') || 'trades';
    
    const db = getDB(env);
    
    // Get table schema using PRAGMA
    const schemaResult = await db.prepare(`PRAGMA table_info(${tableName})`).all<any>();
    const columns = (schemaResult.results || []).map((col: any) => ({
      name: col.name,
      type: col.type,
      not_null: col.notnull === 1,
      default_value: col.dflt_value,
    }));
    
    // Get CREATE TABLE statement
    let createTable = '';
    try {
      const createResult = await db.prepare(`
        SELECT sql FROM sqlite_master 
        WHERE type='table' AND name=?
      `).bind(tableName).first<{ sql: string }>();
      createTable = createResult?.sql || '';
    } catch (error) {
      // If we can't get CREATE TABLE, that's okay
    }
    
    // Get a sample row to see actual data structure
    let sampleRow: any = null;
    try {
      const sampleResult = await db.prepare(`SELECT * FROM ${tableName} LIMIT 1`).first<any>();
      sampleRow = sampleResult || null;
    } catch (error) {
      // If table is empty or error, that's okay
    }
    
    const response: TableSchemaResult = {
      timestamp: new Date().toISOString(),
      table: tableName,
      schema: createTable,
      sample_row: sampleRow,
      columns,
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[debugTableSchema] error', errorMsg);
    return new Response(JSON.stringify({
      error: errorMsg,
      timestamp: new Date().toISOString(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

