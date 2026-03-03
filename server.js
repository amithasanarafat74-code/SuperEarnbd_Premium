const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
    console.error('Error: MONGODB_URI not found in environment variables!');
}

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully!'))
    .catch(err => console.log('MongoDB Connection Error:', err));

// --- DATABASE SCHEMAS ---

// User Schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, unique: true }, // New Field
    password: { type: String, required: true },
    deviceId: { type: String, required: true, unique: true }, // Device Restriction
    
    referralCode: { type: String, unique: true },
    referredBy: { type: String },
    
    active: { type: Boolean, default: false },
    banned: { type: Boolean, default: false },
    
    balances: {
        refer: { type: Number, default: 0 },
        gmail: { type: Number, default: 0 },
        job: { type: Number, default: 0 }
    },
    
    referralCount: { type: Number, default: 0 },
    activeReferrals: { type: Number, default: 0 },
    
    giftHistory: [Object], // For Gift Code History
    gmailRequests: [Object],
    withdrawRequests: [Object],
    completedJobs: [Number],
    typingJobs: [Object],
    
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Settings Schema (for admin)
const settingSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: { type: mongoose.Schema.Types.Mixed }
});
const Setting = mongoose.model('Setting', settingSchema);

// Gift Code Schema
const giftCodeSchema = new mongoose.Schema({
    code: { type: String, unique: true },
    amount: Number,
    used: { type: Boolean, default: false },
    usedBy: { type: String }
});
const GiftCode = mongoose.model('GiftCode', giftCodeSchema);

// --- API ROUTES ---

// 1. REGISTER (Device & Phone Check)
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, phone, referralCode, deviceId } = req.body;

        // Check if device already registered
        const existingDevice = await User.findOne({ deviceId });
        if (existingDevice) {
            return res.status(400).json({ error: 'This device already has an account. You can only login.' });
        }
        
        // Check if phone exists
        if (phone) {
            const existingPhone = await User.findOne({ phone });
            if (existingPhone) return res.status(400).json({ error: 'Phone number already used.' });
        }

        // Check duplicate username/email
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) return res.status(400).json({ error: 'Username or Email already exists' });

        const newUser = new User({
            username, email, password, phone, deviceId,
            referralCode: 'REF' + Math.random().toString(36).substr(2, 8).toUpperCase()
        });

        // Referral Logic
        if (referralCode) {
            const referrer = await User.findOne({ referralCode });
            if (referrer) {
                newUser.referredBy = referrer._id;
                referrer.referralCount++;
                await referrer.save();
            }
        }

        await newUser.save();
        res.json({ success: true, user: newUser });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ $or: [{ email: email }, { username: email }], password: password });
        
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        if (user.banned) return res.status(403).json({ error: 'Your account is banned!' });

        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. GET USER DATA (Refresh)
app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. UPDATE USER (Balance, Ban, Active)
app.post('/api/admin/update-user', async (req, res) => {
    try {
        const { userId, updates } = req.body;
        const user = await User.findByIdAndUpdate(userId, updates, { new: true });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. USER ACTIONS (Withdraw, Gmail, Gift)
app.post('/api/user/action', async (req, res) => {
    try {
        const { userId, type, data } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (type === 'withdraw') {
            if (user.balances[data.wallet] < data.amount) return res.status(400).json({ error: 'Insufficient balance' });
            user.balances[data.wallet] -= data.amount;
            user.withdrawRequests.push(data);
        } 
        else if (type === 'gmail') {
            user.gmailRequests.push(data);
        } 
        else if (type === 'gift') {
            const code = await GiftCode.findOne({ code: data.code, used: false });
            if (!code) return res.status(400).json({ error: 'Invalid or used code' });
            
            code.used = true;
            code.usedBy = userId;
            await code.save();

            user.balances.refer += code.amount;
            user.giftHistory.push({ code: code.code, amount: code.amount, date: new Date() });
        }
        
        await user.save();
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. ADMIN GET ALL USERS
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. ADMIN SETTINGS & GIFT CODES
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { key, value } = req.body;
        await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/settings', async (req, res) => {
    const settings = await Setting.find({});
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json(obj);
});

app.post('/api/admin/create-gift', async (req, res) => {
    try {
        const { code, amount } = req.body;
        const newCode = new GiftCode({ code, amount });
        await newCode.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));