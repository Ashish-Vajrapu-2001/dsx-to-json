
import JSZip from 'jszip';

// Add a custom error class for DSX parsing errors
export class DSXParsingError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'DSXParsingError';
  }
}

export const extractDSXFilesFromZip = async (file: File): Promise<File[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async (event: ProgressEvent<FileReader>) => {
      try {
        const zip = await JSZip.loadAsync(event.target?.result as ArrayBuffer);
        const dsxFiles: File[] = [];

        // Use Promise.all to wait for all async blob operations
        const promises = Object.keys(zip.files)
          .filter(fileName => fileName.endsWith('.dsx'))
          .map(async (fileName) => {
            const zipEntry = zip.files[fileName];
            const blob = await zipEntry.async('blob');
            return new File([blob], zipEntry.name);
          });

        const files = await Promise.all(promises);
        resolve(files);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read the zip file.'));
    };

    reader.readAsArrayBuffer(file);
  });
};

// Extract DataStage job information from DSX format
const extractDSXJobInfo = (dsx_content: string): any => {
  // Initialize result dictionary with enhanced structure
  const result: any = {
    name: "",
    description: "",
    type: "",
    parameters: [],
    sources: [],
    targets: [],
    transforms: [],
    sql_scripts: [],     // Added SQL scripts section
    lookups: [],         // Added lookup configuration section
    filters: [],         // Added filter/constraint information
    specialized_stages: [],
    flow: []
  };

  // Extract job name
  const jobNameMatch = dsx_content.match(/Identifier "([^"]+)"/);
  if (jobNameMatch) {
    result.name = jobNameMatch[1];
  }

  // Extract job description
  const descMatch = dsx_content.match(/FullDescription =\+=\+=\+=([\s\S]*?)=\+=\+=\+=/);
  if (descMatch) {
    const fullDesc = descMatch[1].trim();
    // Extract first paragraph or use full description
    const firstPara = fullDesc.split('\r\n\r\n')[0] || fullDesc;
    result.description = firstPara.replace(/\r?\n/g, ' ').trim();
  }

  // Extract job type
  const jobTypeMatch = dsx_content.match(/JobType "([^"]+)"/);
  if (jobTypeMatch) {
    const jobTypeCode = jobTypeMatch[1];
    const jobTypeMap: Record<string, string> = {
      "0": "Server Job",
      "1": "Parallel Job",
      "2": "Sequence Job",
      "3": "Server Routine"
    };
    result.type = jobTypeMap[jobTypeCode] || `Unknown (${jobTypeCode})`;
  }

  // Extract parameters
  const paramRegex = /BEGIN DSSUBRECORD\s+Name "([^"]+)"\s+Prompt "([^"]*)"\s+Default "([^"]*)"\s+(?:HelpTxt "([^"]*)"\s+)?ParamType "([^"]+)"/g;
  let paramMatch;
  while ((paramMatch = paramRegex.exec(dsx_content)) !== null) {
    const paramName = paramMatch[1];
    const paramPrompt = paramMatch[2];
    const paramDefault = paramMatch[3];
    const paramHelp = paramMatch[4] || "";
    const paramType = paramMatch[5];

    // Map parameter type codes to readable names
    const paramTypeMap: Record<string, string> = {
      "1": "String",
      "2": "Integer",
      "3": "Float",
      "4": "Pathname",
      "5": "List",
      "6": "Date",
      "7": "Time",
      "8": "Timestamp",
      "13": "EnvironmentVar"
    };

    result.parameters.push({
      name: paramName,
      prompt: paramPrompt,
      default: paramDefault,
      help: paramHelp,
      type: paramTypeMap[paramType] || `Unknown (${paramType})`
    });
  }

  // Extract stages from stage list
  const stageListMatch = dsx_content.match(/StageList "(.*?)"/);
  const stageNamesMatch = dsx_content.match(/StageNames "(.*?)"/);

  if (stageListMatch && stageNamesMatch) {
    const stageIds = stageListMatch[1].split('|');
    const stageNames = stageNamesMatch[1].split('|').map(s => s.trim());
    
    const stageMap: Record<string, string> = {};
    
    for (let i = 0; i < stageIds.length; i++) {
      if (i < stageNames.length && stageNames[i] !== " ") {
        stageMap[stageIds[i]] = stageNames[i];
      }
    }
    
    // Extract stage types
    const stageTypeRegex = /BEGIN DSRECORD[\s\S]*?Name "([^"]+)"[\s\S]*?StageType "([^"]+)"[\s\S]*?END DSRECORD/g;
    let stageMatch;
    const stageTypeMap: Record<string, string> = {};
    
    while ((stageMatch = stageTypeRegex.exec(dsx_content)) !== null) {
      const stageName = stageMatch[1];
      const stageType = stageMatch[2];
      if (stageName && stageName !== " " && stageType) {
        stageTypeMap[stageName] = stageType;
      }
    }
    
    // Extract source and target information
    const xmlPropsRegex = /XMLProperties[\s\S]*?Value =\+=\+=\+=([\s\S]*?)=\+=\+=\+=/g;
    let xmlMatch;
    
    while ((xmlMatch = xmlPropsRegex.exec(dsx_content)) !== null) {
      const xmlContent = xmlMatch[1];
      const contextMatch = xmlContent.match(/<Context[^>]*>(\d+)<\/Context>/);
      
      // Extract stage name from preceding record
      const recordContent = dsx_content.substring(0, xmlMatch.index).split("BEGIN DSRECORD").pop() || "";
      const stageNameMatch = recordContent.match(/Name "([^"]+)"/);
      
      if (!stageNameMatch) continue;
      
      const stageName = stageNameMatch[1];
      
      // Process based on context
      if (contextMatch) {
        const context = parseInt(contextMatch[1], 10);
        
        // Inside the extractDSXJobInfo function, modify the source and target extraction sections:
        
        if (context === 1) { // Source context
          const source: any = {
            name: stageName,
            type: stageTypeMap[stageName] || "source",
            columns: [] // Add columns array
          };
          
          // Extract SQL query
          const selectMatch = xmlContent.match(/<SelectStatement[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/s);
          if (selectMatch) {
            // Simplify SQL by removing excess whitespace
            let sql = selectMatch[1].trim();
            sql = sql.replace(/\s+/g, ' ');  // Normalize whitespace
            sql = sql.replace(/\/\*.*?\*\//g, '');  // Remove comments
            
            source.sql = sql;
            
            // Extract WHERE clauses from SQL to capture constraints
            const whereClauses = extractWhereClauses(sql);
            if (whereClauses.length > 0) {
              source.where_clauses = whereClauses;
            }
          }
          
          // Extract table name if no SQL
          if (!source.sql) {
            const tableMatch = xmlContent.match(/<TableName[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
            if (tableMatch) {
              source.table = tableMatch[1];
            }
          }
          
          // Extract connection info
          const serverMatch = xmlContent.match(/<Server[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
          if (serverMatch) {
            source.connection = serverMatch[1].replace(/#[^#]+#/g, '[PARAM]');
          }
          
          // Extract database name if present
          const databaseMatch = xmlContent.match(/<Database[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
          if (databaseMatch) {
            source.database = databaseMatch[1];
          }
          
          // Only add source if we have meaningful information
          if (source.sql || source.table || source.columns.length > 0) {
            result.sources.push(source);
          }
        } else if (context === 2) { // Target context
          const target: any = {
            name: stageName,
            type: stageTypeMap[stageName] || "target",
            columns: [] // Add columns array
          };
          
          // Extract table name
          const tableMatch = xmlContent.match(/<TableName[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
          if (tableMatch) {
            target.table = tableMatch[1];
          }
          
          // Extract write mode
          const writeModeMatch = xmlContent.match(/<WriteMode[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
          if (writeModeMatch) {
            const modes = ["Append", "Create", "Truncate", "Replace"];
            const modeIndex = parseInt(writeModeMatch[1], 10);
            if (modeIndex >= 0 && modeIndex < modes.length) {
              target.mode = modes[modeIndex];
            }
          }
          
          // Extract connection info
          const serverMatch = xmlContent.match(/<Server[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
          if (serverMatch) {
            target.connection = serverMatch[1].replace(/#[^#]+#/g, '[PARAM]');
          }
          
          // Extract database name if present
          const databaseMatch = xmlContent.match(/<Database[^>]*>\s*<!\[CDATA\[(.*?)\]\]>/);
          if (databaseMatch) {
            target.database = databaseMatch[1];
          }
          
          // Only add target if we have meaningful information
          if (target.table || target.dataset || target.columns.length > 0) {
            result.targets.push(target);
          }
        }
      }
    }
    
    // Extract lookup configurations
    const lookupRegex = /StageType "PxLookup"[\s\S]*?Name "([^"]+)"[\s\S]*?(?:END DSRECORD)/g;
    let lookupMatch;
    
    while ((lookupMatch = lookupRegex.exec(dsx_content)) !== null) {
      const lookupSection = lookupMatch[0];
      const lookupName = lookupMatch[1];
      
      const lookupConfig: any = {
        name: lookupName,
        type: "Lookup",
        inputs: [],
        output: "",
        key_columns: [],
        fail_mode: ""
      };
      
      // Extract lookup input links
      const inputRegex = /Identifier "([^"]+P\d+)"[\s\S]*?Name "([^"]+)"[\s\S]*?Partner "([^|]*)"/g;
      let inputMatch;
      
      while ((inputMatch = inputRegex.exec(lookupSection)) !== null) {
        const inputId = inputMatch[1];
        const inputName = inputMatch[2];
        
        // Check if this is a lookup input
        const conditionMatch = lookupSection.match(/LookupFail "([^"]+)"/);
        if (conditionMatch) {
          lookupConfig.inputs.push(inputName);
          lookupConfig.fail_mode = conditionMatch[1]; // continue or fail
        }
      }
      
      // Extract key columns
      const keyRegex = /KeyPosition "([^0])"[\s\S]*?Name "([^"]+)"/g;
      let keyMatch;
      
      while ((keyMatch = keyRegex.exec(lookupSection)) !== null) {
        lookupConfig.key_columns.push(keyMatch[2]);
      }
      
      // Extract lookup type/method
      const lookupTypeMatch = lookupSection.match(/LookupType "([^"]+)"/);
      if (lookupTypeMatch) {
        const lookupTypeMap: Record<string, string> = {
          "0": "Normal",
          "1": "Sparse",
          "2": "Range"
        };
        lookupConfig.lookup_type = lookupTypeMap[lookupTypeMatch[1]] || lookupTypeMatch[1];
      }
      
      // Extract residual handling
      const residualMatch = lookupSection.match(/ResidualHandler "([^"]+)"/);
      if (residualMatch) {
        lookupConfig.residual_handling = residualMatch[1];
      }
      
      // Only add lookup if we have meaningful information
      if (lookupConfig.inputs.length > 0 || lookupConfig.key_columns.length > 0) {
        result.lookups.push(lookupConfig);
      }
    }
    
    // Extract dataset targets
    const datasetRegex = /Name "dataset"[\s\S]*?Value "([^"]+)"/g;
    let datasetMatch;
    
    while ((datasetMatch = datasetRegex.exec(dsx_content)) !== null) {
      const datasetPath = datasetMatch[1];
      const datasetName = datasetPath.split('/').pop() || datasetPath;
      
      // Look for stage name in surrounding context
      const surroundingStart = Math.max(0, datasetMatch.index - 500);
      const surrounding = dsx_content.substring(surroundingStart, datasetMatch.index);
      const stageNameMatch = surrounding.match(/Name "([^"]+)"/);
      
      const target: any = {
        type: "dataset",
        dataset: datasetName
      };
      
      if (stageNameMatch) {
        target.name = stageNameMatch[1];
      }
      
      // Add dataset mode if available
      const contextRange = dsx_content.substring(
        Math.max(0, datasetMatch.index - 200),
        Math.min(dsx_content.length, datasetMatch.index + 200)
      );
      
      const datasetModeMatch = contextRange.match(/Name "datasetmode"[\s\S]*?Value "([^"]+)"/);
      if (datasetModeMatch) {
        target.mode = datasetModeMatch[1];
      }
      
      result.targets.push(target);
    }
    
    // Extract transformation logic
    const trxRegex = /Name "TrxGenCode"[\s\S]*?Value =\+=\+=\+=([\s\S]*?)=\+=\+=\+=/g;
    let trxMatch;
    
    while ((trxMatch = trxRegex.exec(dsx_content)) !== null) {
      const transformCode = trxMatch[1].trim();
      
      // Extract stage name from preceding record
      const recordContent = dsx_content.substring(0, trxMatch.index).split("BEGIN DSRECORD").pop() || "";
      const stageNameMatch = recordContent.match(/Name "([^"]+)"/);
      const stageName = stageNameMatch ? stageNameMatch[1] : "unknown";
      
      // Extract transformation rules
      const rules: string[] = [];
      const lines = transformCode.split('\n');
      
      for (const line of lines) {
        // Look for assignment operations, exclude boilerplate
        if (line.includes('=') && 
            !line.trim().startsWith('//') && 
            !line.trim().startsWith('int') &&
            !line.includes('RowRejected') && 
            !line.includes('NullSet') && 
            !line.includes('inputname') && 
            !line.includes('outputname') && 
            !line.includes('initialize') && 
            !line.includes('mainloop') && 
            !line.includes('finish') && 
            !line.includes('writerecord')) {
          const cleanLine = line.trim();
          if (cleanLine) {
            rules.push(cleanLine.replace(/\s+/g, ' '));
          }
        }
      }
      
      // Only add transform if we have rules
      if (rules.length > 0) {
        result.transforms.push({
          name: stageName,
          rules: rules
        });
      }
    }
    
    // Extract stage connections/flow
    const linkRegex = /BEGIN DSRECORD[\s\S]*?StageType "Link"[\s\S]*?FromStageID "([^"]+)"[\s\S]*?ToStageID "([^"]+)"[\s\S]*?END DSRECORD/g;
    let linkMatch;
    
    while ((linkMatch = linkRegex.exec(dsx_content)) !== null) {
      const fromStageId = linkMatch[1];
      const toStageId = linkMatch[2];
      
      // Find stage names from IDs
      const fromStageName = stageMap[fromStageId] || fromStageId;
      const toStageName = stageMap[toStageId] || toStageId;
      
      result.flow.push({
        from: fromStageName,
        to: toStageName
      });
    }
  }

  // Add metadata
  result.metadata = {
    extractedAt: new Date().toISOString(),
    version: "1.1.0" // Updated version to reflect enhanced extraction
  };

  return result;
};

// Helper function to extract WHERE clauses from SQL
const extractWhereClauses = (sql: string): string[] => {
  const clauses: string[] = [];
  const whereRegex = /\bWHERE\b\s+(.*?)(?:\bGROUP BY\b|\bORDER BY\b|\bHAVING\b|$)/gi;
  
  let match;
  while ((match = whereRegex.exec(sql)) !== null) {
    if (match[1] && match[1].trim()) {
      clauses.push(match[1].trim());
    }
  }
  
  return clauses;
};

// Add validation function
const validateExtractedData = (data: any): { valid: boolean; issues: string[] } => {
  const issues: string[] = [];
  
  // Check required fields
  if (!data.name) {
    issues.push('Missing job name');
  }
  
  if (!data.type) {
    issues.push('Missing job type');
  }
  
  // Check for empty arrays that should have content
  if (data.sources.length === 0 && data.targets.length === 0) {
    issues.push('No sources or targets found - possible parsing issue');
  }
  
  // Check for incomplete flow
  if (data.flow.length > 0) {
    // Create sets of all stages mentioned in flow
    const fromStages = new Set(data.flow.map((f: any) => f.from));
    const toStages = new Set(data.flow.map((f: any) => f.to));
    
    // Check for disconnected stages
    const allStages = new Set([
      ...data.sources.map((s: any) => s.name),
      ...data.targets.map((t: any) => t.name),
      ...data.transforms.map((t: any) => t.name),
      ...(data.lookups || []).map((l: any) => l.name),
      ...(data.specialized_stages || []).map((s: any) => s.name)
    ]);
    
    for (const stage of allStages) {
      if (!fromStages.has(stage) && !toStages.has(stage)) {
        issues.push(`Stage "${stage}" appears disconnected from the flow`);
      }
    }
  }
  
  return {
    valid: issues.length === 0,
    issues
  };
};

export const parseDSXFile = (file: File): Promise<any> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event: ProgressEvent<FileReader>) => {
      try {
        const fileContent = event.target?.result as string;
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(fileContent, 'text/xml');

        // Extract job information
        const jobNode = xmlDoc.querySelector('job');
        
        if (!jobNode) {
          // If no job node is found, try to extract DataStage job info from the DSX format
          const jobData = extractDSXJobInfo(fileContent);
          
          if (Object.keys(jobData).length === 0) {
            reject(new Error('No job information found in the DSX file.'));
            return;
          }
          
          // Validate the extracted data
          const validation = validateExtractedData(jobData);
          
          resolve({
            originalFile: file.name,
            data: jobData,
            validation: validation
          });
          return;
        }

        // Standard XML job extraction
        const jobData: any = {};
        for (let i = 0; i < jobNode.attributes.length; i++) {
          const attribute = jobNode.attributes[i];
          jobData[attribute.name] = attribute.value;
        }

        const stages: any[] = [];
        const stageNodes = xmlDoc.querySelectorAll('stage');
        stageNodes.forEach(stageNode => {
          const stageData: any = {};
          for (let i = 0; i < stageNode.attributes.length; i++) {
            const attribute = stageNode.attributes[i];
            stageData[attribute.name] = attribute.value;
          }
          stages.push(stageData);
        });

        resolve({
          originalFile: file.name,
          data: {
            job: jobData,
            stages: stages
          }
        });
      } catch (error) {
        console.error(`Error parsing DSX file ${file.name}:`, error);
        reject(new DSXParsingError(`Failed to parse DSX file: ${file.name}`, error));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read the DSX file.'));
    };

    reader.readAsText(file);
  });
};

// Add a simple cache for parsed DSX files
const parsedFileCache = new Map<string, any>();

export interface ProcessingProgress {
  total: number;
  processed: number;
  currentFile: string;
}

export const processDSXFiles = async (
  files: File[], 
  onProgress?: (progress: ProcessingProgress) => void
): Promise<any[]> => {
  const results: any[] = [];
  const totalFiles = files.reduce((count, file) => {
    // Estimate zip contents as 5 files on average if we don't know yet
    return count + (file.name.endsWith('.zip') ? 5 : 1);
  }, 0);
  
  let processedCount = 0;
  
  const updateProgress = (currentFile: string) => {
    processedCount++;
    if (onProgress) {
      onProgress({
        total: totalFiles,
        processed: processedCount,
        currentFile
      });
    }
  };

  for (const file of files) {
    const cacheKey = `${file.name}-${file.lastModified}`;
    
    if (file.name.endsWith('.zip')) {
      try {
        const dsxFiles = await extractDSXFilesFromZip(file);
        // Update our estimate with actual count
        const adjustment = dsxFiles.length - 5;
        processedCount = Math.max(0, processedCount - adjustment);
        
        for (const dsxFile of dsxFiles) {
          try {
            // Check cache first
            const dsxCacheKey = `${dsxFile.name}-${dsxFile.lastModified}`;
            let result;
            
            if (parsedFileCache.has(dsxCacheKey)) {
              result = parsedFileCache.get(dsxCacheKey);
              console.log(`Using cached result for ${dsxFile.name}`);
            } else {
              result = await parseDSXFile(dsxFile);
              parsedFileCache.set(dsxCacheKey, result);
            }
            
            results.push(result);
            updateProgress(dsxFile.name);
          } catch (error) {
            console.error(`Error processing DSX file ${dsxFile.name}:`, error);
            updateProgress(dsxFile.name);
          }
        }
      } catch (error) {
        console.error(`Error processing zip file ${file.name}:`, error);
        updateProgress(file.name);
      }
    } else if (file.name.endsWith('.dsx')) {
      try {
        // Check cache first
        let result;
        
        if (parsedFileCache.has(cacheKey)) {
          result = parsedFileCache.get(cacheKey);
          console.log(`Using cached result for ${file.name}`);
        } else {
          result = await parseDSXFile(file);
          parsedFileCache.set(cacheKey, result);
        }
        
        results.push(result);
        updateProgress(file.name);
      } catch (error) {
        console.error(`Error processing DSX file ${file.name}:`, error);
        updateProgress(file.name);
      }
    }
  }

  return results;
};

export const processDSXFilesParallel = async (files: File[], maxConcurrent = 3): Promise<any[]> => {
  const results: any[] = [];
  const queue = [...files];
  const inProgress = new Set();
  
  const processNext = async (): Promise<void> => {
    if (queue.length === 0) return;
    
    const file = queue.shift()!;
    inProgress.add(file.name);
    
    try {
      if (file.name.endsWith('.zip')) {
        const dsxFiles = await extractDSXFilesFromZip(file);
        for (const dsxFile of dsxFiles) {
          try {
            const result = await parseDSXFile(dsxFile);
            results.push(result);
          } catch (error) {
            console.error(`Error processing DSX file ${dsxFile.name}:`, error);
          }
        }
      } else if (file.name.endsWith('.dsx')) {
        const result = await parseDSXFile(file);
        results.push(result);
      }
    } catch (error) {
      console.error(`Error processing file ${file.name}:`, error);
    } finally {
      inProgress.delete(file.name);
      // Process next file
      await processNext();
    }
  };
  
  // Start initial batch of processing
  const initialBatch = Math.min(maxConcurrent, files.length);
  const initialPromises = [];
  
  for (let i = 0; i < initialBatch; i++) {
    initialPromises.push(processNext());
  }
  
  await Promise.all(initialPromises);
  return results;
};

// Add a method to clear the cache if needed
export const clearParserCache = () => {
  parsedFileCache.clear();
};

export const saveAsZip = async (results: any[]): Promise<Blob> => {
  const zip = new JSZip();

  results.forEach((result, index) => {
    const fileName = result.originalFile ? result.originalFile.replace('.dsx', '.json') : `file-${index + 1}.json`;
    const content = JSON.stringify(result.data, null, 2);
    zip.file(fileName, content);
  });

  return zip.generateAsync({ type: 'blob' });
};

export const createFileTree = (results: any[]): any[] => {
  // Return empty array if results is undefined or not an array
  if (!results || !Array.isArray(results)) {
    return [];
  }
  
  // Map the results to the file tree structure
  return results.map(result => {
    const name = result.originalFile || 'unknown.dsx';
    return {
      name: name.replace('.dsx', '.json'),
      type: 'file',
      path: name.replace('.dsx', '.json'),
      content: JSON.stringify(result.data, null, 2),
      jsonContent: result.data
    };
  });
};


/**
 * Maps SQL type codes to readable type strings with appropriate formatting
 * @param sqlType The SQL type code
 * @param precision The precision value (for numeric/string types)
 * @param scale The scale value (for decimal types)
 * @returns A formatted type string
 */
const mapSqlType = (sqlType: string, precision?: string, scale?: string): string => {
  const typeMap: Record<string, string> = {
    "1": "CHAR",
    "2": "NUMERIC",
    "3": "DECIMAL",
    "4": "INTEGER",
    "5": "SMALLINT",
    "6": "FLOAT",
    "7": "REAL",
    "8": "DOUBLE",
    "9": "DATE",
    "10": "TIME",
    "11": "TIMESTAMP",
    "12": "VARCHAR",
    "-1": "LONGVARCHAR",
    "-2": "BINARY",
    "-3": "VARBINARY",
    "-4": "LONGVARBINARY",
    "-5": "BIGINT",
    "-6": "TINYINT",
    "-7": "BIT",
    "-8": "WCHAR",
    "-9": "WVARCHAR",
    "-10": "WLONGVARCHAR",
    "91": "TYPE_DATE",
    "92": "TYPE_TIME",
    "93": "TYPE_TIMESTAMP"
  };

  const typeName = typeMap[sqlType] || `UNKNOWN(${sqlType})`;

  // Format type with precision/scale where appropriate
  if (["NUMERIC", "DECIMAL", "CHAR", "VARCHAR"].includes(typeName)) {
    if (precision && precision !== "0") {
      if (scale && scale !== "0") {
        return `${typeName}(${precision},${scale})`;
      }
      return `${typeName}(${precision})`;
    }
  }

  return typeName;
};


/**
 * Extract configuration details for specialized stage types
 * @param dsxContent The DSX file content
 * @param result The result object to update
 * @param stageTypeMap Map of stage names to their types
 */
const extractSpecializedStages = (dsxContent: string, result: any, stageTypeMap: Record<string, string>): void => {
  const specializedStages: any[] = [];

  // Map of specialized stage types to their extraction functions
  const specializedTypes: Record<string, (stageName: string, stageSection: string) => any> = {
    "PxSort": extractSortStage,
    "PxJoin": extractJoinStage,
    "PxAggregate": extractAggregateStage,
    "PxSurrogateKeyGenerator": extractSurrogateKeyStage,
    "PxPeek": extractPeekStage,
    "PxSCD": extractScdStage,
    "PxPivot": extractPivotStage,
    "PxUnpivot": extractUnpivotStage,
    "PxChangeCapture": extractChangeCaptureStage,
    "PxChecksum": extractChecksumStage
  };

  // Extract stages by type
  for (const [stageName, stageType] of Object.entries(stageTypeMap)) {
    if (specializedTypes[stageType]) {
      // Find the stage record in the DSX content
      const stageRegex = new RegExp(`Name "${escapeRegExp(stageName)}"[\\s\\S]*?StageType "${escapeRegExp(stageType)}"[\\s\\S]*?(?:END DSRECORD|BEGIN DSRECORD)`, 'i');
      const stageMatch = dsxContent.match(stageRegex);

      if (stageMatch && stageMatch[0]) {
        const stageSection = stageMatch[0];
        // Call the appropriate extraction function
        const stageInfo = specializedTypes[stageType](stageName, stageSection);
        if (stageInfo) {
          specializedStages.push(stageInfo);
        }
      }
    }
  }

  // Add to result if we found any
  if (specializedStages.length > 0) {
    result.specialized_stages = specializedStages;
  }
};

/**
 * Helper function to escape special characters in regex
 */
const escapeRegExp = (string: string): string => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Extract Sort stage configuration
 */
const extractSortStage = (stageName: string, stageSection: string): any => {
  const sortInfo: any = {
    name: stageName,
    type: "Sort",
    sort_keys: [],
    options: {}
  };

  // Extract sort keys
  const keyRegex = /Key "([^"]+)".*?SortDirection "([^"]+)"/g;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(stageSection)) !== null) {
    const keyName = keyMatch[1];
    const direction = keyMatch[2] === "0" ? "Ascending" : "Descending";
    sortInfo.sort_keys.push({ column: keyName, direction });
  }

  // Extract sort options
  const stableMatch = stageSection.match(/Stable "([^"]+)"/);
  if (stableMatch) {
    sortInfo.options.stable = stableMatch[1] === "1";
  }

  const uniqueMatch = stageSection.match(/Unique "([^"]+)"/);
  if (uniqueMatch) {
    sortInfo.options.unique = uniqueMatch[1] === "1";
  }

  return sortInfo;
};

/**
 * Extract Join stage configuration
 */
const extractJoinStage = (stageName: string, stageSection: string): any => {
  const joinInfo: any = {
    name: stageName,
    type: "Join",
    join_type: "Unknown",
    join_keys: [],
    options: {}
  };

  // Extract join type
  const joinTypeMatch = stageSection.match(/JoinType "([^"]+)"/);
  if (joinTypeMatch) {
    const joinTypeMap: Record<string, string> = {
      "0": "Inner",
      "1": "Left Outer",
      "2": "Right Outer",
      "3": "Full Outer"
    };
    joinInfo.join_type = joinTypeMap[joinTypeMatch[1]] || `Unknown (${joinTypeMatch[1]})`;
  }

  // Extract join keys
  const keyRegex = /LeftKey "([^"]+)".*?RightKey "([^"]+)"/g;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(stageSection)) !== null) {
    joinInfo.join_keys.push({
      left: keyMatch[1],
      right: keyMatch[2]
    });
  }

  return joinInfo;
};

/**
 * Extract Aggregate stage configuration
 */
const extractAggregateStage = (stageName: string, stageSection: string): any => {
  const aggregateInfo: any = {
    name: stageName,
    type: "Aggregate",
    group_by: [],
    aggregations: []
  };

  // Extract group by columns
  const groupByRegex = /GroupByField "([^"]+)"/g;
  let groupMatch;
  while ((groupMatch = groupByRegex.exec(stageSection)) !== null) {
    aggregateInfo.group_by.push(groupMatch[1]);
  }

  // Extract aggregation functions
  const aggRegex = /AggregateField "([^"]+)".*?AggregateFunction "([^"]+)".*?InputField "([^"]+)"/g;
  let aggMatch;
  while ((aggMatch = aggRegex.exec(stageSection)) !== null) {
    const funcMap: Record<string, string> = {
      "0": "SUM",
      "1": "AVG",
      "2": "MIN",
      "3": "MAX",
      "4": "COUNT",
      "5": "STDDEV",
      "6": "VARIANCE",
      "7": "FIRST",
      "8": "LAST"
    };
    
    aggregateInfo.aggregations.push({
      output: aggMatch[1],
      function: funcMap[aggMatch[2]] || aggMatch[2],
      input: aggMatch[3]
    });
  }

  return aggregateInfo;
};

/**
 * Extract Surrogate Key Generator stage configuration
 */
const extractSurrogateKeyStage = (stageName: string, stageSection: string): any => {
  const keyGenInfo: any = {
    name: stageName,
    type: "Surrogate Key Generator",
    key_column: "",
    options: {}
  };

  // Extract key column name
  const keyColMatch = stageSection.match(/KeyName "([^"]+)"/);
  if (keyColMatch) {
    keyGenInfo.key_column = keyColMatch[1];
  }

  // Extract start value
  const startValMatch = stageSection.match(/StartValue "([^"]+)"/);
  if (startValMatch) {
    keyGenInfo.options.start_value = parseInt(startValMatch[1], 10);
  }

  // Extract increment
  const incrementMatch = stageSection.match(/Increment "([^"]+)"/);
  if (incrementMatch) {
    keyGenInfo.options.increment = parseInt(incrementMatch[1], 10);
  }

  return keyGenInfo;
};

// Placeholder implementations for other specialized stages
const extractPeekStage = (stageName: string, stageSection: string): any => {
  return { name: stageName, type: "Peek" };
};

const extractScdStage = (stageName: string, stageSection: string): any => {
  return { name: stageName, type: "Slowly Changing Dimension" };
};

const extractPivotStage = (stageName: string, stageSection: string): any => {
  return { name: stageName, type: "Pivot" };
};

const extractUnpivotStage = (stageName: string, stageSection: string): any => {
  return { name: stageName, type: "Unpivot" };
};

const extractChangeCaptureStage = (stageName: string, stageSection: string): any => {
  return { name: stageName, type: "Change Capture" };
};

const extractChecksumStage = (stageName: string, stageSection: string): any => {
  return { name: stageName, type: "Checksum" };
};

// ... existing code ...
