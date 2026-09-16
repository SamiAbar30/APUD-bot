import './lib/load-env.mjs';
if(!process.stdout.isTTY){console.error('Run in your own terminal to display the operator key.');process.exit(1);}
if(!process.env.OPERATOR_TOKEN){console.error('Operator key not configured.');process.exit(1);}
console.log(process.env.OPERATOR_TOKEN);
