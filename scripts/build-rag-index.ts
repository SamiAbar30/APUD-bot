/** Embed the package's usable examples with the real online provider and save the RAG index. */
import '../src/config/load-env-file.js';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';
import {AgentPackage} from '../src/core/package-agent/package.js';
import {OpenAIEmbedder,RagIndex,RAG_EMBEDDING_MODEL,RAG_INDEX_DIR} from '../src/core/package-agent/rag-index.js';

const dir=process.env.APOD_AGENT_PACKAGE_DIR;if(!dir)throw new Error('APOD_AGENT_PACKAGE_DIR_REQUIRED');
const ai=conversationAiFromEnv();if(ai.status!=='CONFIGURED'||ai.config.mode!=='online')throw new Error('REAL_ONLINE_AI_REQUIRED');
const pkg=await AgentPackage.load(dir);
const started=Date.now();
const {index,tokens}=await RagIndex.build(pkg,new OpenAIEmbedder(ai.config.baseUrl,ai.config.apiKey,RAG_EMBEDDING_MODEL,60_000));
console.log(JSON.stringify({status:'BUILT',dir:RAG_INDEX_DIR,model:index.meta.model,examples:index.meta.count,dims:index.meta.dims,embeddingTokens:tokens,seconds:Math.round((Date.now()-started)/1000)}));
