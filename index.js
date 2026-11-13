
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ciwub8g.mongodb.net/`);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloopdb");

const users = database.collection("user");
const jobs = database.collection("jobs");
const applications = database.collection("applications");
const payments = database.collection("payments");

/**
 * A job application stored in the `applications` collection.
 *
 * It is a snapshot of the job at apply time plus the applicant identity and
 * lifecycle state, so the seeker dashboard can render a row without joins.
 *
 * @typedef {Object} JobApplication
 * @property {string} jobId
 * @property {string} userId
 * @property {string} email
 * @property {string} jobTitle
 * @property {string} companyName
 * @property {string} category
 * @property {string} jobType
 * @property {boolean} isRemote
 * @property {string} location
 * @property {string} deadline
 * @property {string} appliedAt
 * @property {string} status
 * @property {boolean} archived
 */

const JOB_TYPES = ["full-time", "part-time", "contract", "internship"];

const APPLICATION_STATUSES = [
  "applied",
  "reviewed",
  "shortlisted",
  "interview",
  "offered",
  "rejected",
  "hired",
];

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const isValidDate = (value) =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const isEmail = (value) =>
  isNonEmptyString(value) &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Validate the application payload and keep only the fields
 * the `applications` collection owns.
 *
 * @param {unknown} input
 * @returns {{ data: JobApplication } | { error: string }}
 */
function normalizeApplication(input) {
  if (typeof input !== "object" || input === null) {
    return { error: "Application payload must be an object" };
  }

  const payload = input;

  if (!isNonEmptyString(payload.jobId)) {
    return { error: "jobId is required" };
  }

  if (!isNonEmptyString(payload.userId)) {
    return { error: "userId is required" };
  }

  if (!isEmail(payload.email)) {
    return { error: "A valid email is required" };
  }

  if (!isNonEmptyString(payload.jobTitle)) {
    return { error: "jobTitle is required" };
  }

  if (!isNonEmptyString(payload.companyName)) {
    return { error: "companyName is required" };
  }

  if (!isNonEmptyString(payload.category)) {
    return { error: "category is required" };
  }

  if (!isNonEmptyString(payload.location)) {
    return { error: "location is required" };
  }

  if (!JOB_TYPES.includes(payload.jobType)) {
    return {
      error: `jobType must be one of: ${JOB_TYPES.join(", ")}`,
    };
  }

  if (typeof payload.isRemote !== "boolean") {
    return { error: "isRemote must be a boolean" };
  }

  if (
    payload.deadline !== "" &&
    payload.deadline !== undefined &&
    !isValidDate(payload.deadline)
  ) {
    return { error: "deadline must be a valid date" };
  }

  if (!isValidDate(payload.appliedAt)) {
    return { error: "appliedAt must be a valid ISO date" };
  }

  if (!APPLICATION_STATUSES.includes(payload.status)) {
    return {
      error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}`,
    };
  }

  if (typeof payload.archived !== "boolean") {
    return { error: "archived must be a boolean" };
  }

  return {
    data: {
      jobId: payload.jobId.trim(),
      userId: payload.userId.trim(),
      email: payload.email.trim(),
      jobTitle: payload.jobTitle.trim(),
      companyName: payload.companyName.trim(),
      category: payload.category.trim(),
      jobType: payload.jobType,
      isRemote: payload.isRemote,
      location: payload.location.trim(),
      deadline:
        typeof payload.deadline === "string" ? payload.deadline : "",
      appliedAt: payload.appliedAt,
      status: payload.status,
      archived: payload.archived,
    },
  };
}


// home route
app.get('/', (req, res) => {
  res.send('Hire loop is looping!');
});


// users related apis

app.get('/users', async (req, res) => {
  try {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: "Failed to fetch users" });
  }
});


// Check user's premium status
app.get('/users/:id/premium', async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ error: "Invalid user ID" });
    }

    const query = { _id: new ObjectId(id) };

    const result = await users.findOne(query, {
      projection: { premium: 1 },
    });

    if (!result) {
      return res.status(404).send({ error: "User not found" });
    }

    res.send(result);
  } catch (err) {
    res.status(500).send({ error: "Failed to fetch premium status" });
  }
});


// jobs related apis

app.get('/jobs', async (req, res) => {
  const query = {};

  if (req.query) {
    if (req.query.jobType) {
      query.jobType = req.query.jobType;
    }

    if (req.query.isRemote) {
      query.isRemote = req.query.isRemote === 'true';
    }

    if (req.query.category) {
      query.category = req.query.category;
    }

    if (req.query.search) {
      query.$or = [
        { title: { $regex: req.query.search, $options: 'i' } },
        { company: { $regex: req.query.search, $options: 'i' } },
        { responsibilities: { $regex: req.query.search, $options: 'i' } },
        { requirements: { $regex: req.query.search, $options: 'i' } },
      ];
    }
  }

  const cursor = jobs.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ error: 'Invalid job id' });
    }

    const query = { _id: new ObjectId(id) };
    const result = await jobs.findOne(query);

    if (!result) {
      return res.status(404).send({ error: 'Job not found' });
    }

    res.send(result);
  } catch (err) {
    res.status(500).send({ error: 'Failed to fetch job' });
  }
});

app.post('/jobs', async (req, res) => {
  const job = req.body;
  const result = await jobs.insertOne(job);
  res.send(result);
});

app.delete('/jobs/:id', async (req, res) => {
  try {
    const result = await jobs.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    res.send(result);
  } catch (err) {
    // BSONError when the id is not a valid ObjectId
    res.status(400).send({
      error: 'Invalid job id',
      deletedCount: 0,
    });
  }
});


// applications related apis

app.get('/applications', async (req, res) => {
  const query = {};

  if (req.query.userId) {
    query.userId = req.query.userId;
  }

  if (req.query.jobId) {
    query.jobId = req.query.jobId;
  }

  if (req.query.status) {
    query.status = req.query.status;
  }

  if (req.query.archived !== undefined) {
    query.archived = req.query.archived === 'true';
  }

  const cursor = applications.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.get('/applications/count', async (req, res) => {
  const query = {};

  if (req.query.applicantId) {
    query.userId = req.query.applicantId;
  }

  const result = await applications.countDocuments(query);
  res.send({ count: result });
});

app.post('/applications', async (req, res) => {
  const { data: application, error } = normalizeApplication(req.body);

  if (error) {
    res.status(400).send({ error });
    return;
  }

  // One application per seeker per job.
  const existing = await applications.findOne({
    jobId: application.jobId,
    userId: application.userId,
  });

  if (existing) {
    res.send({
      insertedId: existing._id,
      alreadyApplied: true,
    });
    return;
  }

  const result = await applications.insertOne(application);

  res.status(201).send(result);
});


// ========================================
// Stripe Payment Integration
// ========================================

// Verify Stripe Checkout Session and activate premium.
app.post('/payments/checkout-verify', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).send({
        success: false,
        message: 'Session ID is required',
      });
    }

    // Retrieve the actual session directly from Stripe.
    const checkoutSession = await stripe.checkout.sessions.retrieve(
      sessionId,
      {
        expand: ['payment_intent', 'line_items'],
      }
    );

    const {
      status,
      payment_status,
      customer_email,
      customer_details,
      metadata,
      payment_intent,
      client_reference_id,
      amount_total,
      currency,
      created,
      line_items,
    } = checkoutSession;

    // Verify that the payment is completed and paid.
    if (status !== 'complete' || payment_status !== 'paid') {
      return res.status(400).send({
        success: false,
        message: 'Payment verification failed',
      });
    }

    // Verify the user ID provided by the Stripe Checkout Session.
    const userId = metadata?.userId;

    if (
      !userId ||
      !ObjectId.isValid(userId) ||
      client_reference_id !== userId
    ) {
      return res.status(403).send({
        success: false,
        message: 'Invalid payment user verification',
      });
    }

    const userObjectId = new ObjectId(userId);

    // Check whether this Stripe session has already been verified.
    const sessionQuery = { sessionId };

    const existingPayment = await payments.findOne(sessionQuery);

    // Store the verified payment information.
    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email:
        customer_details?.email || customer_email || null,
      userId,
      amount_total,
      currency,
      planName:
        line_items?.data?.[0]?.description || 'Hireloop Pro Plan',
      payment_date: new Date(created * 1000),
      payment_intent:
        typeof payment_intent === 'object'
          ? payment_intent?.id
          : payment_intent,
    };

    let paymentResult = null;

    if (!existingPayment) {
      paymentResult = await payments.insertOne(payment);
    }

    // Update the user as a premium member.
    // This also repairs premium status if a previous request
    // saved the payment but failed before updating the user.
    const updateResult = await users.updateOne(
      { _id: userObjectId },
      {
        $set: {
          premium: true,
        },
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: 'User not found',
      });
    }

    // Return success for previously verified sessions too.
    if (existingPayment) {
      return res.send({
        success: true,
        alreadyVerified: true,
        message: 'Payment already verified',
      });
    }

    res.send({
      success: true,
      message: 'Payment verified successfully',
      result: paymentResult,
      updateResult,
    });

  } catch (err) {
    console.error('Payment verification error:', err);

    res.status(500).send({
      success: false,
      message: 'Payment verification failed',
    });
  }
});


// start server
app.listen(port, () => {
  console.log(`Hire loop is running on port ${port}`);
});


// import express from 'express';
// import cors from 'cors'
// import 'dotenv/config'
// import { MongoClient, ObjectId } from 'mongodb';

// const app = express();
// const port = process.env.PORT || 5000;

// //middleware
// app.use(express.json());
// app.use(cors());

// const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ciwub8g.mongodb.net/`);



// export async function connectToMongoDB() {
//   try {
//     await client.connect();
//     console.log("You successfully connected to MongoDB!");
//     return client;
//   } catch (err) {
//     console.dir(err);
//   }
// }

// const connectedClient =await connectToMongoDB();
// const database = connectedClient.db("hireloopdb");
// const users = database.collection("user");
// const jobs = database.collection("jobs");
// const applications = database.collection("applications");

// /**
//  * A job application stored in the `applications` collection.
//  *
//  * It is a snapshot of the job at apply time plus the applicant identity and
//  * lifecycle state, so the seeker dashboard can render a row without joins.
//  *
//  * @typedef {Object} JobApplication
//  * @property {string} jobId            - `_id` of the applied job.
//  * @property {string} userId           - `_id` of the seeker who applied.
//  * @property {string} email            - Applicant email at apply time.
//  * @property {string} jobTitle         - Job title snapshot.
//  * @property {string} companyName      - Company name snapshot.
//  * @property {string} category         - Job category, e.g. "Design".
//  * @property {string} jobType          - "full-time" | "part-time" | "contract" | "internship".
//  * @property {boolean} isRemote        - Whether the role is remote.
//  * @property {string} location         - Job location snapshot.
//  * @property {string} deadline         - Application deadline (ISO date), or "".
//  * @property {string} appliedAt        - ISO timestamp of the application.
//  * @property {string} status           - Application lifecycle status.
//  * @property {boolean} archived        - Hidden from the active applications tab.
//  */

// const JOB_TYPES = ["full-time", "part-time", "contract", "internship"];
// const APPLICATION_STATUSES = [
//   "applied",
//   "reviewed",
//   "shortlisted",
//   "interview",
//   "offered",
//   "rejected",
//   "hired",
// ];

// const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
// const isValidDate = (value) => isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
// const isEmail = (value) => isNonEmptyString(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

// /**
//  * Validate the application payload and keep only the fields the
//  * `applications` collection owns. Returns `{ data }` or `{ error }`.
//  *
//  * @param {unknown} input
//  * @returns {{ data: JobApplication } | { error: string }}
//  */
// function normalizeApplication(input) {
//   if (typeof input !== "object" || input === null) {
//     return { error: "Application payload must be an object" };
//   }

//   const payload = input;

//   if (!isNonEmptyString(payload.jobId)) return { error: "jobId is required" };
//   if (!isNonEmptyString(payload.userId)) return { error: "userId is required" };
//   if (!isEmail(payload.email)) return { error: "A valid email is required" };
//   if (!isNonEmptyString(payload.jobTitle)) return { error: "jobTitle is required" };
//   if (!isNonEmptyString(payload.companyName)) return { error: "companyName is required" };
//   if (!isNonEmptyString(payload.category)) return { error: "category is required" };
//   if (!isNonEmptyString(payload.location)) return { error: "location is required" };
//   if (!JOB_TYPES.includes(payload.jobType)) {
//     return { error: `jobType must be one of: ${JOB_TYPES.join(", ")}` };
//   }
//   if (typeof payload.isRemote !== "boolean") return { error: "isRemote must be a boolean" };
//   if (payload.deadline !== "" && payload.deadline !== undefined && !isValidDate(payload.deadline)) {
//     return { error: "deadline must be a valid date" };
//   }
//   if (!isValidDate(payload.appliedAt)) return { error: "appliedAt must be a valid ISO date" };
//   if (!APPLICATION_STATUSES.includes(payload.status)) {
//     return { error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}` };
//   }
//   if (typeof payload.archived !== "boolean") return { error: "archived must be a boolean" };

//   return {
//     data: {
//       jobId: payload.jobId.trim(),
//       userId: payload.userId.trim(),
//       email: payload.email.trim(),
//       jobTitle: payload.jobTitle.trim(),
//       companyName: payload.companyName.trim(),
//       category: payload.category.trim(),
//       jobType: payload.jobType,
//       isRemote: payload.isRemote,
//       location: payload.location.trim(),
//       deadline: typeof payload.deadline === "string" ? payload.deadline : "",
//       appliedAt: payload.appliedAt,
//       status: payload.status,
//       archived: payload.archived,
//     },
//   };
// }


// // const connectedClient = await connectToMongoDB();
// // const database = connectedClient.db("hireloopdb");
// // const users = database.collection("user");
// // const jobs = database.collection("jobs");


// app.get('/', (req, res) => {
//   res.send('Hire loop is looping!');
// });

// app.get('/users', async (req, res) => {
//     const cursor = users.find({});
//     const result = await cursor.toArray();
//     res.send(result);
// })



// // jobs related apis
// app.get('/jobs', async (req, res) => {

//   const query = {};
//     // console.log('query', req.query);
//     if (req.query) {
//         if (req.query.jobType) {
//             query.jobType = req.query.jobType;
//         }
//     }
//      if (req.query.isRemote) {
//             query.isRemote = req.query.isRemote === 'true';
//         }
//         if (req.query.category) {
//             query.category = req.query.category;
//         }
//         if (req.query.search) {
//             query.$or = [
//                 { title: { $regex: req.query.search, $options: 'i' } },
//                 { company: { $regex: req.query.search, $options: 'i' } },
//                 { responsibilities: { $regex: req.query.search, $options: 'i' } },
//                 { requirements: { $regex: req.query.search, $options: 'i' } }
//             ];
//         }
    

//     const cursor = jobs.find(query);
//     const result = await cursor.toArray();
//     res.send(result);
// })

// app.get(`/jobs/:id`, async (req, res) => {
//     const id = req.params.id;
//     const query = { _id: new ObjectId(id) };
//     const result = await jobs.findOne(query);
//     res.send(result);
// })


// app.post('/jobs', async (req, res) => {
//     const job = req.body;
//     const result = await jobs.insertOne(job);
//     res.send(result);
// })

// app.delete('/jobs/:id', async (req, res) => {
//     try {
//         const result = await jobs.deleteOne({ _id: new ObjectId(req.params.id) });
//         res.send(result);
//     } catch (err) {
//         // BSONError when the id is not a valid ObjectId
//         res.status(400).send({ error: 'Invalid job id', deletedCount: 0 });
//     }
// })


// // applications related apis
// app.get('/applications', async (req, res) => {
//     const query = {};
//     if (req.query.userId) {
//         query.userId = req.query.userId;
//     }
//     if (req.query.jobId) {
//         query.jobId = req.query.jobId;
//     }
//     if (req.query.status) {
//         query.status = req.query.status;
//     }
//     if (req.query.archived !== undefined) {
//         query.archived = req.query.archived === 'true';
//     }
//     const cursor = applications.find(query);
//     const result = await cursor.toArray();
//     res.send(result);
// })
// app.get('/applications/count', async (req, res) => {
//     const query = {};
//     if (req.query.applicantId) {
//         query.userId = req.query.applicantId;
//     }
//     const result = await applications.countDocuments(query);
//     res.send({ count: result });
// })



// app.post('/applications', async (req, res) => {
//     const { data: application, error } = normalizeApplication(req.body);
//     if (error) {
//         res.status(400).send({ error });
//         return;
//     }

//     // One application per seeker per job — repeats are flagged, not re-inserted
//     const existing = await applications.findOne({ jobId: application.jobId, userId: application.userId });
//     if (existing) {
//         res.send({ insertedId: existing._id, alreadyApplied: true });
//         return;
//     }

//     const result = await applications.insertOne(application);
//     res.status(201).send(result);
// })



// app.listen(port, () => {
//   console.log(`hire loop is runing... ${port}`);
// });