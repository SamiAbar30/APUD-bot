import {config} from 'dotenv';
const selected=process.env.ENV_FILE;
const loaded=config({path:selected??'.env'});
if(selected&&loaded.error)throw new Error('ENV_FILE_NOT_READABLE');
