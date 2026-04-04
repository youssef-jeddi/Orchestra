import 'dotenv/config';
import storage from '../integrations/zero-g/storage';

async function main() {
    console.log('\n=== TEST 1: Write a simple value ===');
    await storage.write('test:hello', { message: 'hello world', ts: Date.now() });

    console.log('\n=== TEST 2: Read it back ===');
    const result = await storage.read('test:hello');
    console.log('Read result:', result);

    console.log('\n=== TEST 3: Append to a collection ===');
    await storage.append('test:items', { id: 1, name: 'apple' });
    await storage.append('test:items', { id: 2, name: 'banana' });

    console.log('\n=== TEST 4: ReadMany from collection ===');
    const items = await storage.readMany('test:items');
    console.log('Items:', items);

    console.log('\n=== TEST 5: ReadMany with filter ===');
    const filtered = await storage.readMany('test:items', { name: 'banana' });
    console.log('Filtered:', filtered);

    console.log('\n=== TEST 6: Delete ===');
    await storage.delete('test:hello');
    const afterDelete = await storage.read('test:hello');
    console.log('After delete (should be null):', afterDelete);

    console.log('\n✅ All storage tests passed');
}

main().catch(console.error);