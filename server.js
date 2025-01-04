require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk'); // Include Groq
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt'); // Import bcrypt for password hashing
const cors = require('cors'); // Import cors for handling cross-origin requests

// Initialize Express app
const app = express();

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors()); // Use CORS middleware

// Serve static files for frontend (HTML, CSS, JS) and uploaded files
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}
app.use('/uploads', express.static(uploadPath));

// Initialize Multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // Rename the file to include the date for uniqueness
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });

// Initialize SQLite database connection
const dbPath = path.resolve(__dirname, 'judge_dashboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Initialize Database Schema
require('./init_db.js'); // Ensure this script initializes the new tables

// Initialize Groq with your API key
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * API Endpoints
 */
// -------------------- Authentication Endpoint --------------------

// Login Endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Input validation
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    // Query to find the user by username
    const query = `SELECT * FROM USERS WHERE username = ?`;
    db.get(query, [username], async (err, user) => {
      if (err) {
        console.error('Error querying the database:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      if (!user) {
        // User not found
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      try {
        // Compare the provided password with the hashed password in the database
        const match = await bcrypt.compare(password, user.password);

        if (match) {
          // Passwords match, authentication successful
          let redirectUrl = '';

          // Determine the redirect URL based on the user's role
          switch (user.role.toLowerCase()) { // Ensure case-insensitive comparison
            case 'judge_view':
              redirectUrl = 'judge_view.html';
              break;
            case 'superintendent_view':
              redirectUrl = 'superintendent_view.html';
              break;
            case 'police_view':
              redirectUrl = 'police_view.html';
              break;
            case 'cbi_view':
              redirectUrl = 'cbi_view.html';
              break;
            default:
              // If role is not recognized, deny access
              return res.status(403).json({ error: 'Access denied. Invalid role.' });
          }

          // Send the redirect URL to the client
          res.json({ redirect: redirectUrl });
        } else {
          // Passwords do not match
          res.status(401).json({ error: 'Invalid username or password.' });
        }
      } catch (error) {
        console.error('Error comparing passwords:', error);
        res.status(500).json({ error: 'Internal server error.' });
      }
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// -------------------- User Management --------------------

// Get list of users
app.get('/api/users', (req, res) => {
  const query = `SELECT user_id, username, role FROM USERS`;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error fetching users:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.json({ users: rows });
    }
  });
});

// Create a new user
app.post('/api/users', async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Please provide username, password, and role.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10); // Hash the password
    const query = `INSERT INTO USERS (username, password, role) VALUES (?, ?, ?)`;
    db.run(query, [username, hashedPassword, role], function (err) {
      if (err) {
        console.error('Error creating user:', err.message);
        if (err.message.includes('UNIQUE constraint failed')) {
          res.status(400).json({ error: 'Username already exists.' });
        } else {
          res.status(500).json({ error: 'Internal server error' });
        }
      } else {
        res.json({ message: 'User created successfully.', user_id: this.lastID });
      }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a user
app.delete('/api/users/:userId', (req, res) => {
  const userId = req.params.userId;
  const query = `DELETE FROM USERS WHERE user_id = ?`;

  db.run(query, [userId], function (err) {
    if (err) {
      console.error('Error deleting user:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    } else if (this.changes === 0) {
      res.status(404).json({ error: 'User not found.' });
    } else {
      res.json({ message: 'User deleted successfully.' });
    }
  });
});

// -------------------- Groq Integration --------------------

// Route for calling Groq API
app.post('/get-groq-completion', async (req, res) => {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: req.body.message, // Dynamic user input
        },
      ],
      model: 'llama3-8b-8192',
    });

    res.json({
      content: chatCompletion.choices[0]?.message?.content || 'No content',
    });
  } catch (error) {
    console.error('Error getting completion:', error);
    res.status(500).json({ error: 'Error fetching response from Groq' });
  }
});

// -------------------- Case Management --------------------

// API Endpoint to Add a New Case
app.post('/api/cases', (req, res) => {
  const { caseId, caseName, judge, hearingDate } = req.body;

  // Function to validate the hearingDate format (YYYY-MM-DD)
  const isValidDate = (dateString) => {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateString);
  };

  // Basic validation
  if (!caseId || !caseName || !judge || !hearingDate) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Validate the hearingDate format
  if (!isValidDate(hearingDate)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }

  const query = `INSERT INTO JUDGE_CASE (case_id, case_name, judge, hearing_date)
                 VALUES (?, ?, ?, ?)`;
  const params = [caseId, caseName, judge, hearingDate];

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error adding case:', err.message);
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(409).json({ error: 'Case ID already exists.' });
      } else {
        res.status(500).json({ error: 'Internal server error.' });
      }
    } else {
      res.status(201).json({ case: { id: this.lastID, caseId, caseName, judge, hearingDate } });
    }
  });
});

// API Endpoint to Retrieve All Cases
app.get('/api/cases', (req, res) => {
  const query = `SELECT * FROM JUDGE_CASE ORDER BY hearing_date DESC`;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Error retrieving cases:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    } else {
      res.json({ cases: rows });
    }
  });
});

// -------------------- Criminal Management --------------------

// 1. Register Criminal
app.post('/api/register-criminal', upload.single('photo'), (req, res) => {
  const { criminal_id, name, age, gender, nationality } = req.body;
  let photo = null;

  if (req.file) {
    photo = req.file.filename; // Store only the filename
  }

  // Basic validation
  if (!criminal_id || !name || !age || !gender || !nationality) {
    return res.status(400).json({ error: 'All fields except photo are required.' });
  }

  const query = `INSERT INTO SUPERINTENDENT_CRIMINAL (criminal_id, name, age, gender, nationality, photo)
                 VALUES (?, ?, ?, ?, ?, ?)`;
  const params = [criminal_id, name, age, gender, nationality, photo];

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error registering criminal:', err.message);
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(409).json({ error: 'Criminal ID already exists.' });
      } else {
        res.status(500).json({ error: 'Internal server error.' });
      }
    } else {
      res.status(201).json({
        criminal: { criminal_id, name, age, gender, nationality, photo },
      });
    }
  });
});

// 2. Record Crime
app.post('/api/record-crime', (req, res) => {
  const { criminal_id, crime_type, crime_details, crime_date } = req.body;

  // Basic validation
  if (!criminal_id || !crime_type || !crime_details || !crime_date) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if criminal exists
  const checkCriminalQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  db.get(checkCriminalQuery, [criminal_id], (err, row) => {
    if (err) {
      console.error('Error checking criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Criminal ID not found.' });
    }

    // Insert crime details
    const insertCrimeQuery = `INSERT INTO CRIMES (criminal_id, crime_type, crime_details, crime_date)
                              VALUES (?, ?, ?, ?)`;
    const params = [criminal_id, crime_type, crime_details, crime_date];

    db.run(insertCrimeQuery, params, function (err) {
      if (err) {
        console.error('Error recording crime:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
      } else {
        res.status(201).json({
          crime: { crime_id: this.lastID, criminal_id, crime_type, crime_details, crime_date },
        });
      }
    });
  });
});

// 3. Collect Biometrics
app.post(
  '/api/collect-biometrics',
  upload.fields([
    { name: 'photo_front', maxCount: 1 },
    { name: 'photo_side', maxCount: 1 },
    { name: 'photo_back', maxCount: 1 },
    { name: 'fingerprint', maxCount: 1 },
    { name: 'retina_scan', maxCount: 1 },
  ]),
  (req, res) => {
    const { criminal_id, blood_group, dna_info } = req.body;

    // Basic validation
    if (!criminal_id || !blood_group || !dna_info) {
      return res.status(400).json({
        error: 'Criminal ID, Blood Group, and DNA Information are required.',
      });
    }

    // Check if criminal exists
    const checkCriminalQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
    db.get(checkCriminalQuery, [criminal_id], (err, row) => {
      if (err) {
        console.error('Error checking criminal:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Criminal ID not found.' });
      }

      // Check if biometrics already exist
      const checkBiometricsQuery = `SELECT * FROM BIOMETRICS WHERE criminal_id = ?`;
      db.get(checkBiometricsQuery, [criminal_id], (err, bioRow) => {
        if (err) {
          console.error('Error checking biometrics:', err.message);
          return res.status(500).json({ error: 'Internal server error.' });
        }

        const photo_front = req.files['photo_front']
          ? req.files['photo_front'][0].filename
          : bioRow ? bioRow.photo_front : null;
        const photo_side = req.files['photo_side']
          ? req.files['photo_side'][0].filename
          : bioRow ? bioRow.photo_side : null;
        const photo_back = req.files['photo_back']
          ? req.files['photo_back'][0].filename
          : bioRow ? bioRow.photo_back : null;
        const fingerprint = req.files['fingerprint']
          ? req.files['fingerprint'][0].filename
          : bioRow ? bioRow.fingerprint : null;
        const retina_scan = req.files['retina_scan']
          ? req.files['retina_scan'][0].filename
          : bioRow ? bioRow.retina_scan : null;

        if (bioRow) {
          // Update existing biometrics
          const updateBioQuery = `UPDATE BIOMETRICS 
                                  SET photo_front = ?, photo_side = ?, photo_back = ?, blood_group = ?, fingerprint = ?, retina_scan = ?, dna_info = ?
                                  WHERE criminal_id = ?`;
          const params = [
            photo_front,
            photo_side,
            photo_back,
            blood_group,
            fingerprint,
            retina_scan,
            dna_info,
            criminal_id,
          ];

          db.run(updateBioQuery, params, function (err) {
            if (err) {
              console.error('Error updating biometrics:', err.message);
              res.status(500).json({ error: 'Internal server error.' });
            } else {
              res.json({ message: 'Biometrics updated successfully.' });
            }
          });
        } else {
          // Insert new biometrics
          const insertBioQuery = `INSERT INTO BIOMETRICS (criminal_id, photo_front, photo_side, photo_back, blood_group, fingerprint, retina_scan, dna_info)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
          const params = [
            criminal_id,
            photo_front,
            photo_side,
            photo_back,
            blood_group,
            fingerprint,
            retina_scan,
            dna_info,
          ];

          db.run(insertBioQuery, params, function (err) {
            if (err) {
              console.error('Error collecting biometrics:', err.message);
              res.status(500).json({ error: 'Internal server error.' });
            } else {
              res.status(201).json({ message: 'Biometrics collected successfully.' });
            }
          });
        }
      });
    });
  }
);

// 4. Search Criminal
app.get('/api/search-criminal', (req, res) => {
  const { search_by, search_value, page = 1, limit = 10 } = req.query;

  // Validate input
  const validFields = ['criminal_id', 'name', 'blood_group', 'crime_type', 'jail_name', 'dna_info'];
  if (!search_by || !search_value || !validFields.includes(search_by)) {
    return res.status(400).json({ error: 'Invalid search parameters.' });
  }

  const offset = (page - 1) * limit;
  let query = '';
  let params = [`%${search_value}%`, limit, offset];

  if (search_by === 'crime_type') {
    query = `
      SELECT DISTINCT sc.*
      FROM SUPERINTENDENT_CRIMINAL sc
      JOIN CRIMES c ON sc.criminal_id = c.criminal_id
      WHERE c.crime_type LIKE ? LIMIT ? OFFSET ?
    `;
  } else if (search_by === 'blood_group' || search_by === 'dna_info') {
    query = `
      SELECT sc.*
      FROM SUPERINTENDENT_CRIMINAL sc
      JOIN BIOMETRICS b ON sc.criminal_id = b.criminal_id
      WHERE b.${search_by} LIKE ? LIMIT ? OFFSET ?
    `;
  } else {
    query = `
      SELECT sc.*
      FROM SUPERINTENDENT_CRIMINAL sc
      WHERE sc.${search_by} LIKE ? LIMIT ? OFFSET ?
    `;
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error searching criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    // Get total count for pagination
    let countQuery = '';
    let countParams = [`%${search_value}%`];

    if (search_by === 'crime_type') {
      countQuery = `
        SELECT COUNT(DISTINCT sc.criminal_id) as count
        FROM SUPERINTENDENT_CRIMINAL sc
        JOIN CRIMES c ON sc.criminal_id = c.criminal_id
        WHERE c.crime_type LIKE ?
      `;
    } else if (search_by === 'blood_group' || search_by === 'dna_info') {
      countQuery = `
        SELECT COUNT(*) as count
        FROM SUPERINTENDENT_CRIMINAL sc
        JOIN BIOMETRICS b ON sc.criminal_id = b.criminal_id
        WHERE b.${search_by} LIKE ?
      `;
    } else {
      countQuery = `
        SELECT COUNT(*) as count
        FROM SUPERINTENDENT_CRIMINAL sc
        WHERE sc.${search_by} LIKE ?
      `;
    }

    db.get(countQuery, countParams, (err, countRow) => {
      if (err) {
        console.error('Error counting search results:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      res.json({
        results: rows,
        pagination: {
          total: countRow.count,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countRow.count / limit),
        },
      });
    });
  });
});

// 5. Update Criminal Details
app.put('/api/update-criminal', upload.single('photo'), (req, res) => {
  const criminal_id = req.body.criminal_id;
  const { name, age, gender, nationality, cell_number, jail_name } = req.body;
  let photo = null;

  if (req.file) {
    photo = req.file.filename;
  }

  if (!criminal_id) {
    return res.status(400).json({ error: 'Criminal ID is required.' });
  }

  // Build dynamic query based on provided fields
  let fields = [];
  let params = [];

  if (name) {
    fields.push('name = ?');
    params.push(name);
  }
  if (age) {
    fields.push('age = ?');
    params.push(age);
  }
  if (gender) {
    fields.push('gender = ?');
    params.push(gender);
  }
  if (nationality) {
    fields.push('nationality = ?');
    params.push(nationality);
  }
  if (cell_number) {
    fields.push('cell_number = ?');
    params.push(cell_number);
  }
  if (jail_name) {
    fields.push('jail_name = ?');
    params.push(jail_name);
  }
  if (photo) {
    fields.push('photo = ?');
    params.push(photo);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'At least one field must be provided for update.' });
  }

  const query = `UPDATE SUPERINTENDENT_CRIMINAL SET ${fields.join(', ')} WHERE criminal_id = ?`;
  params.push(criminal_id);

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error updating criminal:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    } else if (this.changes === 0) {
      res.status(404).json({ error: 'Criminal ID not found.' });
    } else {
      res.json({ message: 'Criminal details updated successfully.' });
    }
  });
});

// 6. Maintain Location
app.put('/api/maintain-location', (req, res) => {
  const { criminal_id, cell_number, jail_name } = req.body;

  if (!criminal_id || !cell_number || !jail_name) {
    return res.status(400).json({ error: 'Criminal ID, Cell Number, and Jail Name are required.' });
  }

  const query = `UPDATE SUPERINTENDENT_CRIMINAL SET cell_number = ?, jail_name = ? WHERE criminal_id = ?`;
  const params = [cell_number, jail_name, criminal_id];

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error maintaining location:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    } else if (this.changes === 0) {
      res.status(404).json({ error: 'Criminal ID not found.' });
    } else {
      res.json({ message: 'Location updated successfully.' });
    }
  });
});

// 7. Record Meeting
app.post('/api/record-meeting', (req, res) => {
  const { criminal_id, outsider_name, meeting_date, details } = req.body;

  if (!criminal_id || !outsider_name || !meeting_date || !details) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if criminal exists
  const checkCriminalQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  db.get(checkCriminalQuery, [criminal_id], (err, row) => {
    if (err) {
      console.error('Error checking criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Criminal ID not found.' });
    }

    // Insert meeting record
    const insertMeetingQuery = `INSERT INTO MEETING_RECORDS (criminal_id, outsider_name, meeting_date, details)
                                VALUES (?, ?, ?, ?)`;
    const params = [criminal_id, outsider_name, meeting_date, details];

    db.run(insertMeetingQuery, params, function (err) {
      if (err) {
        console.error('Error recording meeting:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
      } else {
        res.status(201).json({
          meeting_record: {
            record_id: this.lastID,
            criminal_id,
            outsider_name,
            meeting_date,
            details,
          },
        });
      }
    });
  });
});

// 8. Record Health
app.post('/api/record-health', (req, res) => {
  const { criminal_id, health_condition } = req.body;

  if (!criminal_id || !health_condition) {
    return res.status(400).json({ error: 'Criminal ID and Health Condition are required.' });
  }

  // Check if criminal exists
  const checkCriminalQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  db.get(checkCriminalQuery, [criminal_id], (err, row) => {
    if (err) {
      console.error('Error checking criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Criminal ID not found.' });
    }

    // Check if health record exists
    const checkHealthQuery = `SELECT * FROM HEALTH_RECORDS WHERE criminal_id = ?`;
    db.get(checkHealthQuery, [criminal_id], (err, healthRow) => {
      if (err) {
        console.error('Error checking health records:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      if (healthRow) {
        // Update existing health record
        const updateHealthQuery = `UPDATE HEALTH_RECORDS SET health_condition = ? WHERE criminal_id = ?`;
        db.run(updateHealthQuery, [health_condition, criminal_id], function (err) {
          if (err) {
            console.error('Error updating health records:', err.message);
            res.status(500).json({ error: 'Internal server error.' });
          } else {
            res.json({ message: 'Health condition updated successfully.' });
          }
        });
      } else {
        // Insert new health record
        const insertHealthQuery = `INSERT INTO HEALTH_RECORDS (criminal_id, health_condition)
                                   VALUES (?, ?)`;
        db.run(insertHealthQuery, [criminal_id, health_condition], function (err) {
          if (err) {
            console.error('Error recording health condition:', err.message);
            res.status(500).json({ error: 'Internal server error.' });
          } else {
            res.status(201).json({ message: 'Health condition recorded successfully.' });
          }
        });
      }
    });
  });
});

// 9. Assign Works
app.post('/api/assign-works', (req, res) => {
  const { criminal_id, work_description, assign_date } = req.body;

  if (!criminal_id || !work_description || !assign_date) {
    return res.status(400).json({
      error: 'Criminal ID, Work Description, and Assign Date are required.',
    });
  }

  // Check if criminal exists
  const checkCriminalQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  db.get(checkCriminalQuery, [criminal_id], (err, row) => {
    if (err) {
      console.error('Error checking criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Criminal ID not found.' });
    }

    // Insert assign works record
    const insertAssignQuery = `INSERT INTO ASSIGN_WORKS (criminal_id, work_description, assign_date)
                               VALUES (?, ?, ?)`;
    const params = [criminal_id, work_description, assign_date];

    db.run(insertAssignQuery, params, function (err) {
      if (err) {
        console.error('Error assigning works:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
      } else {
        res.status(201).json({
          assign_work: {
            assign_id: this.lastID,
            criminal_id,
            work_description,
            assign_date,
          },
        });
      }
    });
  });
});

// 10. Profile Settings (Update Credentials)
app.put('/api/update-credentials', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Check if user exists
    const checkUserQuery = `SELECT * FROM USERS WHERE username = ?`;
    db.get(checkUserQuery, [username], (err, row) => {
      if (err) {
        console.error('Error checking user:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      if (row) {
        // Update existing user
        const updateUserQuery = `UPDATE USERS SET password = ? WHERE username = ?`;
        db.run(updateUserQuery, [hashedPassword, username], function (err) {
          if (err) {
            console.error('Error updating user credentials:', err.message);
            res.status(500).json({ error: 'Internal server error.' });
          } else {
            res.json({ message: 'Credentials updated successfully.' });
          }
        });
      } else {
        // Create new user
        const insertUserQuery = `INSERT INTO USERS (username, password) VALUES (?, ?)`;
        db.run(insertUserQuery, [username, hashedPassword], function (err) {
          if (err) {
            console.error('Error creating user:', err.message);
            res.status(500).json({ error: 'Internal server error.' });
          } else {
            res.status(201).json({ message: 'User created and credentials updated successfully.' });
          }
        });
      }
    });
  } catch (error) {
    console.error('Error updating credentials:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// -------------------- Police Dashboard --------------------

// Assign Jail to Criminal (Updated to include cell number)
app.post('/api/assign-jail', (req, res) => {
  const { criminal_id, jail_name, cell_number } = req.body;

  if (!criminal_id || !jail_name || !cell_number) {
    return res.status(400).json({ error: 'Criminal ID, Jail Name, and Cell Number are required.' });
  }

  // Check if criminal exists
  const checkCriminalQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  db.get(checkCriminalQuery, [criminal_id], (err, criminal) => {
    if (err) {
      console.error('Error checking criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!criminal) {
      return res.status(404).json({ error: 'Criminal ID not found.' });
    }

    // Insert or Update into POLICE_JAIL table
    const upsertQuery = `
      INSERT INTO POLICE_JAIL (criminal_id, jail_name, cell_number)
      VALUES (?, ?, ?)
      ON CONFLICT(criminal_id) DO UPDATE SET jail_name = excluded.jail_name, cell_number = excluded.cell_number
    `;
    db.run(upsertQuery, [criminal_id, jail_name, cell_number], function (err) {
      if (err) {
        console.error('Error assigning jail:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      // Also update the criminal's jail_name and cell_number in SUPERINTENDENT_CRIMINAL table
      const updateCriminalQuery = `UPDATE SUPERINTENDENT_CRIMINAL SET jail_name = ?, cell_number = ? WHERE criminal_id = ?`;
      db.run(updateCriminalQuery, [jail_name, cell_number, criminal_id], function (err) {
        if (err) {
          console.error('Error updating criminal jail name and cell number:', err.message);
          return res.status(500).json({ error: 'Internal server error.' });
        }

        res.json({ message: 'Jail and cell number assigned successfully.' });
      });
    });
  });
});

// Transfer Criminal (New Endpoint)
app.post('/api/transfer-criminal', (req, res) => {
  const { criminal_id, current_jail, target_jail, target_cell_number } = req.body;

  if (!criminal_id || !current_jail || !target_jail || !target_cell_number) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if criminal exists
  const checkCriminalQuery = `SELECT jail_name FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  db.get(checkCriminalQuery, [criminal_id], (err, criminal) => {
    if (err) {
      console.error('Error checking criminal:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!criminal) {
      return res.status(404).json({ error: 'Criminal ID not found.' });
    }

    if (criminal.jail_name !== current_jail) {
      return res.status(400).json({ error: 'Current jail does not match the criminal\'s current jail.' });
    }

    // Update the criminal's jail_name and cell_number
    const updateCriminalQuery = `UPDATE SUPERINTENDENT_CRIMINAL SET jail_name = ?, cell_number = ? WHERE criminal_id = ?`;
    db.run(updateCriminalQuery, [target_jail, target_cell_number, criminal_id], function (err) {
      if (err) {
        console.error('Error transferring criminal:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      // Update or insert into POLICE_JAIL table
      const upsertPoliceJailQuery = `
        INSERT INTO POLICE_JAIL (criminal_id, jail_name, cell_number)
        VALUES (?, ?, ?)
        ON CONFLICT(criminal_id) DO UPDATE SET jail_name = excluded.jail_name, cell_number = excluded.cell_number
      `;
      db.run(upsertPoliceJailQuery, [criminal_id, target_jail, target_cell_number], function (err) {
        if (err) {
          console.error('Error updating police jail record:', err.message);
          return res.status(500).json({ error: 'Internal server error.' });
        }

        res.json({ message: 'Criminal transferred successfully.' });
      });
    });
  });
});

// Get All Information about a Criminal
app.get('/api/criminal-info/:criminal_id', (req, res) => {
  const { criminal_id } = req.params;

  if (!criminal_id) {
    return res.status(400).json({ error: 'Criminal ID is required.' });
  }

  // Fetch data from various tables
  const basicInfoQuery = `SELECT * FROM SUPERINTENDENT_CRIMINAL WHERE criminal_id = ?`;
  const biometricsQuery = `SELECT * FROM BIOMETRICS WHERE criminal_id = ?`;
  const crimesQuery = `SELECT * FROM CRIMES WHERE criminal_id = ?`;
  const meetingsQuery = `SELECT * FROM MEETING_RECORDS WHERE criminal_id = ?`;
  const healthQuery = `SELECT * FROM HEALTH_RECORDS WHERE criminal_id = ?`;
  const worksQuery = `SELECT * FROM ASSIGN_WORKS WHERE criminal_id = ?`;
  const cbiCasesQuery = `SELECT * FROM CBI_CASE_REPORTS WHERE case_id IN (SELECT crime_id FROM CRIMES WHERE criminal_id = ?)`;
  const cbiEvidenceQuery = `SELECT * FROM CBI_EVIDENCE WHERE case_id IN (SELECT crime_id FROM CRIMES WHERE criminal_id = ?)`;

  db.get(basicInfoQuery, [criminal_id], (err, basicInfo) => {
    if (err) {
      console.error('Error fetching basic info:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!basicInfo) {
      return res.status(404).json({ error: 'Criminal not found.' });
    }

    db.get(biometricsQuery, [criminal_id], (err, biometrics) => {
      if (err) {
        console.error('Error fetching biometrics:', err.message);
        return res.status(500).json({ error: 'Internal server error.' });
      }

      db.all(crimesQuery, [criminal_id], (err, crimes) => {
        if (err) {
          console.error('Error fetching crimes:', err.message);
          return res.status(500).json({ error: 'Internal server error.' });
        }

        db.all(meetingsQuery, [criminal_id], (err, meetings) => {
          if (err) {
            console.error('Error fetching meetings:', err.message);
            return res.status(500).json({ error: 'Internal server error.' });
          }

          db.get(healthQuery, [criminal_id], (err, health) => {
            if (err) {
              console.error('Error fetching health records:', err.message);
              return res.status(500).json({ error: 'Internal server error.' });
            }

            db.all(worksQuery, [criminal_id], (err, works) => {
              if (err) {
                console.error('Error fetching works:', err.message);
                return res.status(500).json({ error: 'Internal server error.' });
              }

              // Fetch CBI-specific data
              db.all(cbiCasesQuery, [criminal_id], (err, cbiCases) => {
                if (err) {
                  console.error('Error fetching CBI cases:', err.message);
                  return res.status(500).json({ error: 'Internal server error.' });
                }

                db.all(cbiEvidenceQuery, [criminal_id], (err, cbiEvidence) => {
                  if (err) {
                    console.error('Error fetching CBI evidence:', err.message);
                    return res.status(500).json({ error: 'Internal server error.' });
                  }

                  res.json({
                    basicInfo,
                    biometrics,
                    crimes,
                    meetings,
                    health,
                    works,
                    cbiCases,
                    cbiEvidence,
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// -------------------- Judge Dashboard --------------------

// 13. Update Case (Judge Dashboard)
app.put('/api/cases/:id', (req, res) => {
  const { id } = req.params;
  const { case_id, case_name, judge, hearing_date } = req.body;

  if (!case_id && !case_name && !judge && !hearing_date) {
    return res.status(400).json({ error: 'At least one field is required for update.' });
  }

  let fields = [];
  let params = [];

  if (case_id) {
    fields.push('case_id = ?');
    params.push(case_id);
  }
  if (case_name) {
    fields.push('case_name = ?');
    params.push(case_name);
  }
  if (judge) {
    fields.push('judge = ?');
    params.push(judge);
  }
  if (hearing_date) {
    fields.push('hearing_date = ?');
    params.push(hearing_date);
  }

  const query = `UPDATE JUDGE_CASE SET ${fields.join(', ')} WHERE id = ?`;
  params.push(id);

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error updating case:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    } else if (this.changes === 0) {
      res.status(404).json({ error: 'Case not found.' });
    } else {
      res.json({ message: 'Case updated successfully.' });
    }
  });
});

// 14. Delete Case (Judge Dashboard)
app.delete('/api/cases/:id', (req, res) => {
  const { id } = req.params;

  const query = `DELETE FROM JUDGE_CASE WHERE id = ?`;
  const params = [id];

  db.run(query, params, function (err) {
    if (err) {
      console.error('Error deleting case:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    } else if (this.changes === 0) {
      res.status(404).json({ error: 'Case not found.' });
    } else {
      res.json({ message: 'Case deleted successfully.' });
    }
  });
});

// -------------------- CBI Dashboard --------------------

// 1. File Case Report
app.post('/api/file-case-report', (req, res) => {
  const { case_id, case_name, description } = req.body;

  if (!case_id || !case_name || !description) {
    return res.status(400).json({ error: 'Case ID, Case Name, and Description are required.' });
  }

  const insertCaseQuery = `INSERT INTO CBI_CASE_REPORTS (case_id, case_name, description)
                           VALUES (?, ?, ?)`;
  const params = [case_id, case_name, description];

  db.run(insertCaseQuery, params, function (err) {
    if (err) {
      console.error('Error filing case report:', err.message);
      if (err.message.includes('UNIQUE constraint failed')) {
        res.status(409).json({ error: 'Case ID already exists.' });
      } else {
        res.status(500).json({ error: 'Internal server error.' });
      }
    } else {
      res.status(201).json({
        case_report: { id: this.lastID, case_id, case_name, description },
        message: 'Case report filed successfully.',
      });
    }
  });
});

// 2. Add Evidence
app.post('/api/add-evidence', upload.single('evidence_file'), (req, res) => {
  const { case_id, evidence_description } = req.body;
  let evidence_file = null;

  if (req.file) {
    evidence_file = req.file.filename;
  } else {
    return res.status(400).json({ error: 'Evidence file is required.' });
  }

  if (!case_id || !evidence_description) {
    return res.status(400).json({ error: 'Case ID and Evidence Description are required.' });
  }

  // Check if case exists
  const checkCaseQuery = `SELECT * FROM CBI_CASE_REPORTS WHERE case_id = ?`;
  db.get(checkCaseQuery, [case_id], (err, caseRow) => {
    if (err) {
      console.error('Error checking case:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!caseRow) {
      return res.status(404).json({ error: 'Case ID not found.' });
    }

    const insertEvidenceQuery = `INSERT INTO CBI_EVIDENCE (case_id, evidence_description, evidence_file)
                                 VALUES (?, ?, ?)`;
    const params = [case_id, evidence_description, evidence_file];

    db.run(insertEvidenceQuery, params, function (err) {
      if (err) {
        console.error('Error adding evidence:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
      } else {
        res.status(201).json({
          evidence: { id: this.lastID, case_id, evidence_description, evidence_file },
          message: 'Evidence added successfully.',
        });
      }
    });
  });
});

// -------------------- Graceful Shutdown --------------------

/**
 * Close the database connection gracefully on server shutdown
 */
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('Error closing SQLite database:', err.message);
    } else {
      console.log('Closed SQLite database connection.');
    }
    process.exit(0);
  });
});

/**
 * Start the Server
 */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
// Serve static files for frontend (HTML, CSS, JS)
app.use(express.static('public'));