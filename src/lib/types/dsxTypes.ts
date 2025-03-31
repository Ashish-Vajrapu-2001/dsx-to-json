export interface DSXParameter {
  name: string;
  prompt: string;
  default: string;
  help: string;
  type: string;
}

export interface DSXColumn {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
}

export interface DSXSource {
  name: string;
  type: string;
  sql?: string;
  table?: string;
  connection?: string;
  database?: string;
  where_clauses?: string[];
  columns?: DSXColumn[];
}

export interface DSXTarget {
  name: string;
  type: string;
  table?: string;
  dataset?: string;
  mode?: string;
  connection?: string;
  database?: string;
  columns?: DSXColumn[];
}

export interface DSXTransform {
  name: string;
  rules: string[];
}

export interface DSXLookup {
  name: string;
  type: string;
  inputs: string[];
  output: string;
  key_columns: string[];
  fail_mode: string;
  lookup_type?: string;
  residual_handling?: string;
}

export interface DSXJobInfo {
  name: string;
  description: string;
  type: string;
  parameters: DSXParameter[];
  sources: DSXSource[];
  targets: DSXTarget[];
  transforms: DSXTransform[];
  sql_scripts: {
    stage: string;
    type: string;
    sql: string;
    where_clauses?: string[];
  }[];
  lookups: DSXLookup[];
  filters: {
    stage: string;
    condition: string;
  }[];
  specialized_stages: any[];
  flow: any[];
  metadata: {
    extractedAt: string;
    version: string;
  };
}