const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};
let roomTimers = {};

io.on('connection', (socket) => {
    // 【加入房間】
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                hostId: socket.id, 
                players: [], 
                status: 'waiting', 
                votes: {}, 
                nightAction: { killedId: null, savedId: null, poisonedId: null }
            };
        }
        const room = rooms[roomId];

        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        // 判定新加入的人是否為房長
        const isFirst = room.players.length === 0;
        const player = { 
            id: socket.id, 
            name: username, 
            role: null, 
            isHost: isFirst || (socket.id === room.hostId), 
            isAlive: true 
        };
        
        if (isFirst) room.hostId = socket.id;
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    // --- 訊息處理 ---
    socket.on('sendMessage', (d) => {
        const room = rooms[socket.roomId];
        // 夜晚禁言 (除了系統訊息)
        if (room?.status === 'night') return;
        io.to(socket.roomId).emit('receiveMessage', d);
    });

    // 【新功能：狼人專屬對話】
    socket.on('sendWolfMessage', (d) => {
        const room = rooms[socket.roomId];
        const sender = room?.players.find(p => p.id === socket.id);
        if (sender?.role === '狼人') {
            room.players.forEach(p => {
                if (p.role === '狼人') io.to(p.id).emit('receiveWolfMessage', d);
            });
        }
    });

    // --- 角色行動 ---
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night') room.nightAction.killedId = targetId;
    });

    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (room?.status === 'night' && player?.role === '預言家') {
            const target = room.players.find(p => p.id === targetId);
            const side = target?.role === '狼人' ? '壞人 (狼人)' : '好人';
            socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
        }
    });

    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night') {
            if (type === 'save') room.nightAction.savedId = targetId;
            if (type === 'poison') room.nightAction.poisonedId = targetId;
        }
    });

    // --- 投票邏輯 ---
    socket.on('castVote', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status !== 'voting') return;

        room.votes[socket.id] = targetId; // targetId 為 null 代表棄票
        const alivePlayers = room.players.filter(p => p.isAlive);
        
        if (Object.keys(room.votes).length >= alivePlayers.length) {
            settleVote(socket.roomId);
        }
    });

    // 【流程：黑夜】
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);

        room.status = 'night';
        room.nightAction = { killedId: null, savedId: null, poisonedId: null };
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🌙 天黑請閉眼，狼人請行動。", isSystem: true });

        let nightLeft = 30;
        roomTimers[roomId] = setInterval(() => {
            nightLeft--;
            io.to(roomId).emit('timerUpdate', nightLeft);
            if (nightLeft <= 0) settleNight(roomId);
        }, 1000);
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        clearInterval(roomTimers[roomId]);

        let deadIds = [];
        const { killedId, savedId, poisonedId } = room.nightAction;
        if (killedId && killedId !== savedId) deadIds.push(killedId);
        if (poisonedId) deadIds.push(poisonedId);

        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        const deadNames = room.players.filter(p => deadIds.includes(p.id)).map(p => p.name);
        
        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: `🌅 天亮了！${deadNames.length > 0 ? "昨晚死的是：" + deadNames.join(', ') : "昨晚是個平安夜。"}`, 
            isSystem: true 
        });

        if (!checkGameOver(roomId)) startDay(roomId);
    }

    // 【流程：白天發言】
    function startDay(roomId) {
        const room = rooms[roomId];
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        room.status = 'day';
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        let timeLeft = 60; 
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) startVoting(roomId);
        }, 1000);
    }

    // 【流程：投票】
    function startVoting(roomId) {
        const room = rooms[roomId];
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        
        room.status = 'voting';
        room.votes = {};
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🗳️ 進入投票階段，超過半數投票即處決。", isSystem: true });

        let voteTime = 20;
        roomTimers[roomId] = setInterval(() => {
            voteTime--;
            io.to(roomId).emit('timerUpdate', voteTime);
            if (voteTime <= 0) settleVote(roomId);
        }, 1000);
    }

    function settleVote(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        clearInterval(roomTimers[roomId]);

        const tally = {};
        Object.values(room.votes).forEach(id => { if (id) tally[id] = (tally[id] || 0) + 1; });

        const aliveCount = room.players.filter(p => p.isAlive).length;
        const half = aliveCount / 2;
        let expelled = null;

        for (const [id, count] of Object.entries(tally)) {
            if (count > half) {
                expelled = room.players.find(p => p.id === id);
                break;
            }
        }

        if (expelled) {
            expelled.isAlive = false;
            io.to(roomId).emit('receiveMessage', { name: "系統", text: `📢 處決結果：${expelled.name} 被投出 (${tally[expelled.id]} 票)。`, isSystem: true });
        } else {
            io.to(roomId).emit('receiveMessage', { name: "系統", text: "📢 投票結果：票數未過半，無人處決。", isSystem: true });
        }

        if (!checkGameOver(roomId)) triggerNight(roomId);
    }

    // 【房長跳過發言】
    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') startVoting(socket.roomId);
    });

    // 【遊戲開始】
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return;
        
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i] || '村民';
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    // 【斷線處理：包含房長遞補邏輯】
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;

        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
            clearInterval(roomTimers[roomId]);
            delete rooms[roomId];
        } else {
            // 房長遞補
            if (socket.id === room.hostId) {
                const newHost = room.players[0];
                room.hostId = newHost.id;
                newHost.isHost = true;
                io.to(newHost.id).emit('hostStatus', true);
                io.to(roomId).emit('receiveMessage', { name: "系統", text: `👑 房長離開，由 ${newHost.name} 接任。`, isSystem: true });
            }
            io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        }
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');
        if (wolves.length === 0) { endGame(roomId, "好人陣營"); return true; }
        if (wolves.length >= humans.length) { endGame(roomId, "狼人陣營"); return true; }
        return false;
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner, allRoles: rooms[roomId].players });
        rooms[roomId].status = 'waiting';
        clearInterval(roomTimers[roomId]);
    }
});

server.listen(process.env.PORT || 3000);
