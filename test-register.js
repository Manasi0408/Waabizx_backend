// Simple test script for register API
// Run: node test-register.js

const axios = require('axios');

async function testRegister() {
  console.log('🧪 Testing Register API...\n');
  
  try {
    const testData = {
      name: 'Test User',
      email: `test${Date.now()}@example.com`, // Unique email
      password: 'password123'
    };
    
    console.log('Sending request with data:', {
      ...testData,
      password: '***'
    });
    
    const response = await axios.post('http://localhost:5000/api/auth/register', testData, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('\n✅ SUCCESS!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    console.log('\n❌ ERROR!');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Error:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log('Error:', error.message);
      console.log('Make sure server is running on port 5000');
    }
  }
}

testRegister();

