const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg'); 

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Postgres Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

// Automatically create the users table in your Postgres database if it doesn't exist
const initDbMatrix = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                username VARCHAR(50) PRIMARY KEY,
                display_name VARCHAR(100),
                password VARCHAR(100),
                phone VARCHAR(50),
                street VARCHAR(255),
                building VARCHAR(50),
                apt VARCHAR(50),
                joined TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Database matrix synchronized successfully: Users table is ready.");
    } catch (err) {
        console.error("Error initializing database matrix:", err);
    }
};
initDbMatrix();

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Persistent Session Configuration
app.use(session({ 
    store: new FileStore({ path: './sessions', logFn: function(){} }),
    secret: 'tailtrail-ultra-secret', 
    resave: false, 
    saveUninitialized: false,
    cookie: { 
        maxAge: 365 * 24 * 60 * 60 * 1000,
        secure: false 
    }
}));

// Local JSON Databases Initialization
const dbFiles = {
    bookings: 'bookings.json',
    reviews: 'reviews.json',
    tracking: 'tracking.json',
    prices: 'prices.json'
};

for (const key in dbFiles) {
    if (!fs.existsSync(dbFiles[key])) {
        fs.writeFileSync(dbFiles[key], JSON.stringify([]));
    }
}
if (!fs.existsSync('tracking.json')) fs.writeFileSync('tracking.json', JSON.stringify({ link: "No active walk right now." }));

const readDb = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeDb = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Initialize Default Prices Matrix if empty
let currentPrices = readDb(dbFiles.prices);
if (Object.keys(currentPrices).length === 0) {
    currentPrices = {
        single_30_small: 100, single_30_medium: 150, single_30_large: 175,
        single_60_small: 150, single_60_medium: 250, single_60_large: 300,
        sub_small: 450,        sub_medium: 650,        sub_large: 750
    };
    writeDb(dbFiles.prices, currentPrices);
}

// Security Middlewares
const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized access" });
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    const username = req.session.user.username.toLowerCase();
    if (username === 'ytg' || username === 'judymassoud') {
        return next();
    }
    res.status(403).json({ error: "Access Denied: Administrators Only." });
};

// Cursing Censor Engine
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'bastard', 'sharmoota', 'kosomak', 'عرص', 'شرموطة', 'كسمك']; 
function censorText(text) {
    let censored = text;
    BAD_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b|${word}`, 'gi');
        censored = censored.replace(regex, '****');
    });
    return censored;
}

// --- API ENDPOINTS ---

// GET CURRENT SYSTEM PRICES
app.get('/api/prices', (req, res) => {
    res.json(readDb(dbFiles.prices));
});

// ADMIN ONLY: UPDATE LIVE PRICES
app.post('/api/admin/update-prices', requireAuth, requireAdmin, (req, res) => {
    const updated = req.body;
    const priceMatrix = {};
    for (const key in updated) {
        priceMatrix[key] = parseInt(updated[key]) || 0;
    }
    writeDb(dbFiles.prices, priceMatrix);
    res.json({ success: true, prices: priceMatrix });
});

// REGISTER ACCOUNT
app.post('/api/register', async (req, res) => {
    const { username, displayName, password, phone, street, building, apt } = req.body;
    const cleanUsername = username.trim().toLowerCase();
    
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [cleanUsername]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: "Username is already taken. Try another!" });
        }
        
        const insertQuery = `
            INSERT INTO users (username, display_name, password, phone, street, building, apt) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `;
        const result = await pool.query(insertQuery, [cleanUsername, displayName, password, phone, street, building, apt]);
        const newUser = {
            username: result.rows[0].username,
            displayName: result.rows[0].display_name,
            password: result.rows[0].password,
            phone: result.rows[0].phone,
            street: result.rows[0].street,
            building: result.rows[0].building,
            apt: result.rows[0].apt,
            joined: result.rows[0].joined
        };
        
        req.session.user = newUser;
        res.json({ success: true, user: newUser });
    } catch (err) {
        res.status(500).json({ error: "Database error during registration." });
    }
});

// SECURE LOGIN
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const cleanUsername = username.trim().toLowerCase();
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [cleanUsername, password]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid username or password." });
        }
        
        const user = {
            username: result.rows[0].username,
            displayName: result.rows[0].display_name,
            password: result.rows[0].password,
            phone: result.rows[0].phone,
            street: result.rows[0].street,
            building: result.rows[0].building,
            apt: result.rows[0].apt,
            joined: result.rows[0].joined
        };
        
        req.session.user = user;
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: "Database error during login." });
    }
});

// UPDATE USER PROFILE SETTINGS
app.post('/api/update-profile', requireAuth, async (req, res) => {
    const { displayName, phone, street, building, apt, password } = req.body;
    const username = req.session.user.username;
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User profile not found inside data matrix." });
        }

        const current = result.rows[0];
        const updatedDisplayName = displayName || current.display_name;
        const updatedPhone = phone || current.phone;
        const updatedStreet = street || current.street;
        const updatedBuilding = building || current.building;
        const updatedApt = apt || current.apt;
        const updatedPassword = (password && password.trim() !== "") ? password : current.password;

        const updateQuery = `
            UPDATE users 
            SET display_name = $1, phone = $2, street = $3, building = $4, apt = $5, password = $6 
            WHERE username = $7 RETURNING *
        `;
        const updatedResult = await pool.query(updateQuery, [
            updatedDisplayName, updatedPhone, updatedStreet, updatedBuilding, updatedApt, updatedPassword, username
        ]);

        const updatedUser = {
            username: updatedResult.rows[0].username,
            displayName: updatedResult.rows[0].display_name,
            password: updatedResult.rows[0].password,
            phone: updatedResult.rows[0].phone,
            street: updatedResult.rows[0].street,
            building: updatedResult.rows[0].building,
            apt: updatedResult.rows[0].apt,
            joined: updatedResult.rows[0].joined
        };
        
        req.session.user = updatedUser;
        res.json({ success: true, user: updatedUser });
    } catch (err) {
        res.status(500).json({ error: "Database error updating profile settings." });
    }
});

// CHECK AUTH STATUS
app.get('/api/me', async (req, res) => {
    if (req.session.user) {
        try {
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [req.session.user.username]);
            if (result.rows.length > 0) {
                const currentUser = {
                    username: result.rows[0].username,
                    displayName: result.rows[0].display_name,
                    password: result.rows[0].password,
                    phone: result.rows[0].phone,
                    street: result.rows[0].street,
                    building: result.rows[0].building,
                    apt: result.rows[0].apt,
                    joined: result.rows[0].joined
                };
                req.session.user = currentUser;
                const uname = currentUser.username.toLowerCase();
                const isAdmin = (uname === 'ytg' || uname === 'judymassoud');
                return res.json({ loggedIn: true, user: currentUser, isAdmin });
            }
        } catch (err) {
            return res.json({ loggedIn: true, user: req.session.user, isAdmin: false });
        }
    }
    res.json({ loggedIn: false, isAdmin: false });
});

// LOGOUT
app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: "Could not log out" });
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// BOOK A WALK (PAYMENTS FULLY INTEGRATED INTO WHATSAPP TEXT GENERATION)
app.post('/api/book', requireAuth, (req, res) => {
    const { dogName, breed, size, orderType, walkDuration, extraTime, walkDate, pickupTime, paymentMethod } = req.body;
    let bookings = readDb(dbFiles.bookings);
    const rates = readDb(dbFiles.prices);
    
    let finalizedPrice = 0;
    let planSummary = "";

    if (orderType === "subscription") {
        planSummary = "Weekly Subscription (30 Mins/Day, 5 Days/Week)";
        finalizedPrice = rates[`sub_${size}`];
    } else {
        const extraHalfHours = parseInt(extraTime) || 0;
        const overtimeCost = extraHalfHours * 50;

        if (walkDuration === "30") {
            planSummary = `Single 30-Min Walk (+${extraHalfHours * 30}m extra)`;
            finalizedPrice = rates[`single_30_${size}`] + overtimeCost;
        } else {
            planSummary = `Single 1-Hour Walk (+${extraHalfHours * 30}m extra)`;
            finalizedPrice = rates[`single_60_${size}`] + overtimeCost;
        }
    }

    // Default formatting if frontend drops empty field
    const chosenPayment = paymentMethod || "Cash"; 
    const addressStr = `${req.session.user.street}, Bldg ${req.session.user.building}, Apt ${req.session.user.apt}`;
    
    const newBooking = {
        userAccount: req.session.user.username,
        userPhone: req.session.user.phone,
        userName: req.session.user.displayName,
        address: addressStr,
        dogName, breed, size, plan: planSummary,
        price: `${finalizedPrice} EGP`,
        scheduledDate: walkDate, scheduledTime: pickupTime,
        paymentMethod: chosenPayment,
        dateBooked: new Date().toLocaleDateString('en-US'),
        status: 'Active'
    };
    
    bookings.push(newBooking);
    writeDb(dbFiles.bookings, bookings);
    
    const myWhatsAppNumber = "201038997757"; 
    const textMessage = `🐾 *Tail Trail - New Booking Request* 🐾\n\n` +
                        `👤 *Client Name:* ${req.session.user.displayName} (@${req.session.user.username})\n` +
                        `📞 *Contact Number:* ${req.session.user.phone}\n` +
                        `📍 *Pickup Address:* ${addressStr}\n\n` +
                        `🗓️ *Requested Date:* ${walkDate}\n` +
                        `⏰ *Time Frame:* ${pickupTime}\n\n` +
                        `🐶 *Pet Name:* ${dogName}\n` +
                        `🧬 *Breed:* ${breed}\n` +
                        `⚖️ *Size Category:* ${size.toUpperCase()}\n` +
                        `🗓️ *Selected Plan:* ${planSummary}\n` +
                        `💰 *Total Rate:* ${finalizedPrice} EGP\n\n` +
                        `💳 *Intended Payment Option:* ${chosenPayment} (To be paid AFTER the walk)\n\n` +
                        `Please verify this schedule window to confirm our session. Thank u!`;
    
    res.json({ 
        success: true, 
        whatsappUrl: `https://wa.me/${myWhatsAppNumber}?text=${encodeURIComponent(textMessage)}` 
    });
});

// GET MY BOOKINGS, REVIEWS, GALLERY
app.get('/api/my-books', requireAuth, (req, res) => {
    let bookings = readDb(dbFiles.bookings);
    res.json(bookings.filter(b => b.userAccount === req.session.user.username));
});
app.get('/api/reviews', (req, res) => res.json(readDb(dbFiles.reviews)));
app.post('/api/reviews', (req, res) => {
    let reviews = readDb(dbFiles.reviews);
    reviews.unshift({ name: censorText(req.body.name), text: censorText(req.body.text), date: new Date().toLocaleDateString() });
    writeDb(dbFiles.reviews, reviews);
    res.redirect('/index.html');
});
app.post('/api/reviews/delete', requireAuth, (req, res) => {
    let reviews = readDb(dbFiles.reviews);
    if (reviews[req.body.index] && reviews[req.body.index].name === req.session.user.displayName) {
        reviews.splice(req.body.index, 1);
        writeDb(dbFiles.reviews, reviews);
        return res.json({ success: true });
    }
    res.status(403).json({ error: "Unauthorized" });
});
app.get('/api/gallery', (req, res) => {
    fs.readdir(path.join(__dirname, 'public', 'gallery'), (err, files) => {
        if (err) return res.json([]);
        res.json(files.filter(file => /\.(jpg|jpeg|png|webp|gif)$/i.test(file)));
    });
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));