const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    console.log('Creating WaabizX knowledge base...');

    const vectorStore = await client.vectorStores.create({
      name: 'WaabizX Knowledge Base',
    });

    console.log('Vector store created:');
    console.log(vectorStore.id);

    const filePath = path.join(
      __dirname,
      '..',
      'knowledge',
      'company-overview.txt'
    );

    if (!fs.existsSync(filePath)) {
      throw new Error(`Knowledge file not found: ${filePath}`);
    }

    console.log('Uploading:');
    console.log(filePath);

    const uploadedFile = await client.vectorStores.files.uploadAndPoll(
      vectorStore.id,
      fs.createReadStream(filePath)
    );

    console.log('File uploaded successfully.');
    console.log('File ID:', uploadedFile.id);
    console.log('Status:', uploadedFile.status);

    console.log('\n=================================');
    console.log('WAABIZX VECTOR STORE ID');
    console.log('=================================');
    console.log(vectorStore.id);
    console.log('=================================\n');

    console.log('Save this Vector Store ID in your .env file as OPENAI_VECTOR_STORE_ID.');
  } catch (error) {
    console.error('Knowledge base creation failed:');
    console.error(error);
    process.exit(1);
  }
}

main();
