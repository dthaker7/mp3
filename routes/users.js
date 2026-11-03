
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

module.exports = function (router) {
    const fail = (status, message) => {
        const error = new Error(message);
        error.status = status;
        throw error;
    };

    function handleError(res, error) {
        const status = error.status ||
            (error.code === 11000 || error.name === 'ValidationError' ||
             error.name === 'CastError' || error instanceof SyntaxError
                ? 400 : 500);

        const message = status === 500
            ? 'Internal server error'
            : error.status ? error.message : 'Invalid request';

        if (status === 500) console.error(error);
        return res.status(status).json({ message, data: null });
    }

    function parseJSON(value, fallback) {
        return value === undefined ? fallback : JSON.parse(value);
    }

    function validateUser(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            fail(400, 'Invalid user data');
        }

        if (typeof body.name !== 'string' || !body.name.trim()) {
            fail(400, 'A valid name is required');
        }

        if (typeof body.email !== 'string' || !body.email.trim()) {
            fail(400, 'A valid email is required');
        }

        const pendingTasks = body.pendingTasks === undefined
            ? [] : body.pendingTasks;

        if (!Array.isArray(pendingTasks) ||
            pendingTasks.some(id =>
                typeof id !== 'string' ||
                !mongoose.isValidObjectId(id))) {
            fail(400, 'pendingTasks must contain valid task IDs');
        }

        if (new Set(pendingTasks).size !== pendingTasks.length) {
            fail(400, 'Duplicate task IDs are not allowed');
        }

        return pendingTasks;
    }

    async function validateTasks(taskIds, session) {
        if (!taskIds.length) return [];

        const tasks = await Task.find({
            _id: { $in: taskIds }
        }).session(session);

        if (tasks.length !== taskIds.length) {
            fail(404, 'One or more tasks do not exist');
        }

        if (tasks.some(task => task.completed)) {
            fail(400, 'Completed tasks cannot be pending');
        }

        return tasks;
    }

    async function ensureUniqueEmail(email, excludedId, session) {
        const query = { email };
        if (excludedId) query._id = { $ne: excludedId };

        const existing = await User.findOne(query).session(session);
        if (existing) fail(400, 'Email already exists');
    }

    // GET /api/users
    router.get('/', async (req, res) => {
        try {
            const where = parseJSON(req.query.where, {});
            const sort = parseJSON(req.query.sort, {});
            const select = parseJSON(req.query.select, {});
            const skip = req.query.skip === undefined
                ? 0 : Number(req.query.skip);
            const limit = req.query.limit === undefined
                ? null : Number(req.query.limit);

            if (!Number.isInteger(skip) || skip < 0 ||
                (limit !== null &&
                 (!Number.isInteger(limit) || limit < 0))) {
                fail(400, 'Invalid pagination');
            }

            if (req.query.count === 'true') {
                const count = await User.countDocuments(where);
                return res.status(200).json({
                    message: 'User count retrieved',
                    data: count
                });
            }

            const query = User.find(where)
                .sort(sort)
                .select(select)
                .skip(skip);

            if (limit !== null) query.limit(limit);

            return res.status(200).json({
                message: 'Users retrieved',
                data: await query.exec()
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // POST /api/users
    router.post('/', async (req, res) => {
        try {
            const pendingTasks = validateUser(req.body);
            let createdUser;

            await mongoose.connection.transaction(async session => {
                await ensureUniqueEmail(
                    req.body.email, null, session
                );

                const tasks = await validateTasks(
                    pendingTasks, session
                );

                const users = await User.create([{
                    name: req.body.name,
                    email: req.body.email,
                    pendingTasks
                }], { session });

                createdUser = users[0];

                for (const task of tasks) {
                    if (task.assignedUser) {
                        await User.updateOne(
                            { _id: task.assignedUser },
                            { $pull: {
                                pendingTasks: task._id.toString()
                            }},
                            { session }
                        );
                    }

                    task.assignedUser = createdUser._id.toString();
                    task.assignedUserName = createdUser.name;
                    await task.save({ session });
                }
            });

            return res.status(201).json({
                message: 'User created',
                data: createdUser
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // GET /api/users/:id
    router.get('/:id', async (req, res) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                fail(404, 'User not found');
            }

            const select = parseJSON(req.query.select, {});
            const user = await User.findById(req.params.id)
                .select(select);

            if (!user) fail(404, 'User not found');

            return res.status(200).json({
                message: 'User retrieved',
                data: user
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // PUT /api/users/:id
    router.put('/:id', async (req, res) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                fail(404, 'User not found');
            }

            let updatedUser;

            await mongoose.connection.transaction(async session => {
                const user = await User.findById(req.params.id)
                    .session(session);

                if (!user) fail(404, 'User not found');

                const newPending = validateUser(req.body);

                await ensureUniqueEmail(
                    req.body.email, user._id, session
                );

                const tasks = await validateTasks(
                    newPending, session
                );

                const userId = user._id.toString();
                const oldPending = user.pendingTasks;
                const newSet = new Set(newPending);

                // Unassign pending tasks removed from this user.
                await Task.updateMany(
                    {
                        assignedUser: userId,
                        completed: false,
                        _id: { $nin: newPending }
                    },
                    {
                        $set: {
                            assignedUser: '',
                            assignedUserName: 'unassigned'
                        }
                    },
                    { session }
                );

                // Move newly assigned tasks from other users.
                for (const task of tasks) {
                    if (task.assignedUser &&
                        task.assignedUser !== userId) {
                        await User.updateOne(
                            { _id: task.assignedUser },
                            { $pull: {
                                pendingTasks: task._id.toString()
                            }},
                            { session }
                        );
                    }

                    task.assignedUser = userId;
                    task.assignedUserName = req.body.name;
                    await task.save({ session });
                }

                // Rename all other tasks still assigned to user,
                // including completed tasks.
                await Task.updateMany(
                    { assignedUser: userId },
                    { $set: {
                        assignedUserName: req.body.name
                    }},
                    { session }
                );

                user.name = req.body.name;
                user.email = req.body.email;
                user.pendingTasks = newPending;

                await user.save({ session });
                updatedUser = user;
            });

            return res.status(200).json({
                message: 'User updated',
                data: updatedUser
            });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // DELETE /api/users/:id
    router.delete('/:id', async (req, res) => {
        try {
            if (!mongoose.isValidObjectId(req.params.id)) {
                fail(404, 'User not found');
            }

            await mongoose.connection.transaction(async session => {
                const user = await User.findById(req.params.id)
                    .session(session);

                if (!user) fail(404, 'User not found');

                await Task.updateMany(
                    { assignedUser: user._id.toString() },
                    { $set: {
                        assignedUser: '',
                        assignedUserName: 'unassigned'
                    }},
                    { session }
                );

                await User.deleteOne(
                    { _id: user._id },
                    { session }
                );
            });

            return res.status(204).send();
        } catch (error) {
            return handleError(res, error);
        }
    });

    return router;
};
