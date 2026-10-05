const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

    if (!vectorStoreId) {
      throw new Error('OPENAI_VECTOR_STORE_ID is missing from .env');
    }

    const fileName = process.argv[2];

    if (!fileName) {
      throw new Error(
        'Please provide a file name.\nExample:\nnode scripts/uploadKnowledgeFile.js waabizx-pricing.txt'
      );
    }

    const filePath = path.join(__dirname, '..', 'knowledge', fileName);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    console.log('Uploading knowledge file...');
    console.log(fileName);

    const uploadedFile = await client.vectorStores.files.uploadAndPoll(
      vectorStoreId,
      fs.createReadStream(filePath)
    );

    console.log('\nUpload completed.');
    console.log('File ID:', uploadedFile.id);
    console.log('Status:', uploadedFile.status);
  } catch (error) {
    console.error('\nUpload failed:');
    console.error(error);
    process.exit(1);
  }
}

main();
