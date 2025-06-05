const { newQuickJSWASMModule } = require('quickjs-emscripten');
const { Arena } = require('./dist/quickjs-emscripten-sync.umd.js');

async function quickTest() {
  console.log('🧪 Quick function marshalling test...');
  
  const QuickJS = await newQuickJSWASMModule();
  const context = QuickJS.newContext();
  
  const arena = new Arena(context);
  
  // Test function marshalling
  const testObj = {
    getValue: () => 42,
    data: { x: 10, y: 20 },
    multiply: (a, b) => a * b
  };
  
  arena.expose({ funcTest: testObj });
  
  try {
    console.log('Testing simple function...');
    const result1 = arena.evalCode('funcTest.getValue()');
    console.log('✓ getValue() result:', result1);
    
    console.log('Testing function with parameters...');
    const result2 = arena.evalCode('funcTest.multiply(5, 8)');
    console.log('✓ multiply(5, 8) result:', result2);
    
    console.log('Testing object property access...');
    const result3 = arena.evalCode('funcTest.data.x + funcTest.data.y');
    console.log('✓ data.x + data.y result:', result3);
    
    console.log('🎉 All function tests passed!');
    
  } catch (error) {
    console.log('❌ Function test failed:', error.message);
  }
  
  arena.dispose();
  context.dispose();
}

quickTest().catch(console.error); 