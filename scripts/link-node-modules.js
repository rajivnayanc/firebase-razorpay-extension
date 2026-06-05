const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '../node_modules');
const junctionPath = path.resolve(__dirname, '../sample-app/functions/node_modules');

// Ensure parent directory exists
const parentDir = path.dirname(junctionPath);
if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
}

if (!fs.existsSync(junctionPath)) {
    try {
        fs.symlinkSync(target, junctionPath, 'junction');
        console.log('Successfully created node_modules junction for sample-app/functions');
    } catch (err) {
        console.error('Failed to create node_modules junction:', err.message);
    }
} else {
    console.log('node_modules directory or junction already exists at target path.');
}
