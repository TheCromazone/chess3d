// Static content for the Learn section: endgame drills and a beginner lesson curriculum.
// Every FEN and every goal move here is checked by tools/test-data.mjs with chess.js.
//
// ENDGAME_DRILLS: play `fen` as `side` (always the side to move) against the engine.
//   goal "win":  checkmate the opponent.
//   goal "draw": don't lose: reach stalemate, repetition, insufficient material or the
//                50-move rule (a controller may also count "survived N moves" as success).
//   difficulty: 1 (basic) .. 3 (advanced technique).
//
// LESSONS: steps are shown in order. Every step's FEN has the learner (White in all current
// lessons) to move, info steps included, so the board never needs to flip mid-lesson.
//   goal { type: "info" }                 -> just text; show a "Next" button.
//   goal { type: "move", moves: [uci] }   -> any of the listed UCI moves (e.g. "e2e4", "e1g1", "a7a8q").
//   goal { type: "mate" }                 -> any move that gives checkmate.
//   goal { type: "capture", square }      -> any legal capture landing on `square`.

export const ENDGAME_DRILLS = [
  {
    id: "kq-vs-k", title: "Queen Checkmate", side: "w", goal: "win", difficulty: 1,
    fen: "8/8/8/4k3/8/8/8/3QK3 w - - 0 1",
    blurb: "Use the queen to shrink the king's box a knight's move away, bring your own king up, and mate on the edge. Watch out for stalemate!",
  },
  {
    id: "kr-vs-k", title: "Rook Checkmate", side: "w", goal: "win", difficulty: 1,
    fen: "8/8/8/4k3/8/8/8/R3K3 w - - 0 1",
    blurb: "Cut the king off with the rook, walk your king up to take the opposition, and push the enemy king to the edge one rank at a time.",
  },
  {
    id: "kbb-vs-k", title: "Two Bishops Checkmate", side: "w", goal: "win", difficulty: 2,
    fen: "8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1",
    blurb: "Side by side, the bishops build a diagonal wall. Herd the king into a corner with help from your own king, then mate.",
  },
  {
    id: "kbn-vs-k", title: "Bishop and Knight Checkmate", side: "w", goal: "win", difficulty: 3,
    fen: "8/8/8/4k3/8/8/8/1N2KB2 w - - 0 1",
    blurb: "The hardest basic mate: drive the king to a corner of your bishop's color. You have 50 moves, so use the 'W' knight manoeuvre.",
  },
  {
    id: "kp-vs-k-key-square", title: "King and Pawn: Key Squares", side: "w", goal: "win", difficulty: 1,
    fen: "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1",
    blurb: "Your king is on the sixth rank in front of its pawn, which wins no matter who moves. Escort the pawn home without allowing stalemate.",
  },
  {
    id: "kp-vs-k-opposition", title: "King and Pawn: Opposition", side: "w", goal: "win", difficulty: 2,
    fen: "8/8/4k3/8/4K3/8/4P3/8 w - - 0 1",
    blurb: "The kings face each other and it is your move. Spend a pawn tempo to hand the move back and win the opposition.",
  },
  {
    id: "kp-vs-k-defend", title: "King and Pawn: Hold the Draw", side: "b", goal: "draw", difficulty: 2,
    fen: "4k3/8/8/8/4P3/4K3/8/8 b - - 0 1",
    blurb: "Stay in front of the pawn and take the opposition whenever White's king comes close. Retreat straight back, not to the side.",
  },
  {
    id: "square-of-the-pawn", title: "The Square of the Pawn", side: "b", goal: "draw", difficulty: 1,
    fen: "8/8/8/8/P2k4/8/8/7K b - - 0 1",
    blurb: "Can your king catch the a-pawn? Draw the square from the pawn to its queening rank; if your king can step into it, you are in time.",
  },
  {
    id: "pawn-breakthrough", title: "Pawn Breakthrough", side: "w", goal: "win", difficulty: 2,
    fen: "7k/ppp5/8/PPP5/8/8/8/6K1 w - - 0 1",
    blurb: "Three pawns against three and both kings far away. Sacrifice two pawns in the right order so the third one queens.",
  },
  {
    id: "q-vs-pawn", title: "Queen vs Pawn on the 7th", side: "w", goal: "win", difficulty: 2,
    fen: "K7/8/8/8/8/8/3pk3/7Q w - - 0 1",
    blurb: "Check and pin until the black king has to stand in front of its own pawn, then use that tempo to bring your king closer.",
  },
  {
    id: "lucena", title: "Lucena Position", side: "w", goal: "win", difficulty: 3,
    fen: "1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1",
    blurb: "The most important winning rook endgame: push the defending king away with a check, then 'build a bridge' with your rook on the fourth rank.",
  },
  {
    id: "philidor", title: "Philidor Position", side: "b", goal: "draw", difficulty: 2,
    fen: "4k3/R7/1r6/3KP3/8/8/8/8 b - - 0 1",
    blurb: "Keep your rook on the sixth rank so White's king can't advance. Once the pawn steps to e6, swing the rook back and check from behind.",
  },
  {
    id: "vancura", title: "Vancura Position", side: "b", goal: "draw", difficulty: 3,
    fen: "R7/6k1/P4r2/8/8/8/6K1/8 b - - 0 1",
    blurb: "Against a rook pawn, attack it from the side and keep your rook on the sixth rank, checking the white king whenever it approaches.",
  },
  {
    id: "opposite-bishops", title: "Opposite-Colored Bishops", side: "b", goal: "draw", difficulty: 1,
    fen: "8/8/3k1b2/3P4/2B1P3/5K2/8/8 b - - 0 1",
    blurb: "Two pawns down, yet a draw: blockade on the dark squares, which White's light-squared bishop can never challenge.",
  },
  {
    id: "wrong-rook-pawn", title: "The Wrong Rook Pawn", side: "b", goal: "draw", difficulty: 1,
    fen: "7k/8/6K1/7P/8/8/4B3/8 b - - 0 1",
    blurb: "White's bishop can't control h8, so your king can never be driven out of the corner. Shuffle between g8 and h8.",
  },
];

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const LESSONS = [
  {
    id: "rook-and-bishop", title: "The Rook and the Bishop", category: "Basics",
    steps: [
      { text: "The rook moves any number of squares in a straight line: up, down, left or right. It can't jump over other pieces.",
        fen: "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Slide the rook all the way across the board to h4.",
        fen: "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["d4h4"] } },
      { text: "Pieces capture by moving onto an enemy piece's square. Capture the black knight with your rook.",
        fen: "7k/8/8/8/3R2n1/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "g4" } },
      { text: "The bishop moves any number of squares diagonally. It always stays on squares of one color.",
        fen: "4k3/7p/8/8/3B4/8/7P/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Move the bishop to the corner square h8.",
        fen: "4k3/7p/8/8/3B4/8/7P/4K3 w - - 0 1", goal: { type: "move", moves: ["d4h8"] } },
      { text: "Capture the black rook with your bishop.",
        fen: "4k3/r7/8/8/3B4/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "a7" } },
    ],
  },
  {
    id: "queen-and-king", title: "The Queen and the King", category: "Basics",
    steps: [
      { text: "The queen is the strongest piece: she moves like a rook and a bishop combined, any distance in any straight line.",
        fen: "4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Move the queen diagonally to a7.",
        fen: "4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["d4a7"] } },
      { text: "Capture the black rook with your queen.",
        fen: "4k3/8/8/8/3Q3r/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "h4" } },
      { text: "The king moves one square in any direction. It may never move onto a square where it could be captured.",
        fen: "4k3/7p/8/8/8/8/7P/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Step your king one square forward, toward the center.",
        fen: "4k3/7p/8/8/8/8/7P/4K3 w - - 0 1", goal: { type: "move", moves: ["e1d2", "e1e2", "e1f2"] } },
      { text: "The king can capture too, as long as the piece is unprotected. Take the pawn.",
        fen: "4k3/8/8/4p3/4K3/8/8/8 w - - 0 1", goal: { type: "capture", square: "e5" } },
    ],
  },
  {
    id: "knight", title: "The Knight", category: "Basics",
    steps: [
      { text: "The knight moves in an L: two squares in one direction, then one square to the side. It is the only piece that can jump over others.",
        fen: "4k3/7p/8/8/3N4/8/7P/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Jump the knight to e6.",
        fen: "4k3/7p/8/8/3N4/8/7P/4K3 w - - 0 1", goal: { type: "move", moves: ["d4e6"] } },
      { text: "Your knight is surrounded by pawns, but knights jump! Leap over them and capture the bishop.",
        fen: "4k3/8/8/8/8/2b5/PPPP4/1N2K3 w - - 0 1", goal: { type: "capture", square: "c3" } },
    ],
  },
  {
    id: "pawns", title: "Pawns and Promotion", category: "Basics",
    steps: [
      { text: "Pawns move straight forward one square, or two squares on their very first move. They never move backwards.",
        fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Push the pawn two squares forward.",
        fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", goal: { type: "move", moves: ["e2e4"] } },
      { text: "Pawns capture one square diagonally forward. The pawn in front blocks you, but the knight is a target. Capture it!",
        fen: "4k3/8/8/3np3/4P3/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "d5" } },
      { text: "A pawn that reaches the last rank promotes, usually to a queen. Promote your pawn to a queen.",
        fen: "7k/P7/8/8/8/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["a7a8q"] } },
    ],
  },
  {
    id: "check-and-checkmate", title: "Check and Checkmate", category: "Basics",
    steps: [
      { text: "A king that is attacked is in check. Checkmate means the king is in check and has no way out: that wins the game.",
        fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", goal: { type: "info" } },
      { text: "Give check: move the rook so it attacks the black king.",
        fen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1", goal: { type: "move", moves: ["a1a8"] } },
      { text: "Now you are in check from the rook on e8! Get out of check. Here the only way is to move your king.",
        fen: "4r1k1/8/8/8/8/8/5PPP/4K3 w - - 0 1", goal: { type: "move", moves: ["e1d1", "e1d2", "e1f1"] } },
      { text: "Your king guards g7 and h7. Find a queen move that gives checkmate.",
        fen: "7k/8/6K1/8/8/8/8/1Q6 w - - 0 1", goal: { type: "mate" } },
      { text: "If a player has no legal move but is NOT in check, it is stalemate, and the game is a draw. Here Qb6?? would leave Black with no move at all. Always leave the losing king a move until you can mate it!",
        fen: "k7/2K5/8/8/8/8/8/1Q6 w - - 0 1", goal: { type: "info" } },
    ],
  },
  {
    id: "special-moves", title: "Castling and En Passant", category: "Basics",
    steps: [
      { text: "Castling moves the king two squares toward a rook, and the rook jumps to the king's other side. It is allowed only if neither piece has moved, the squares between are empty, and the king is not in, through or into check.",
        fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", goal: { type: "info" } },
      { text: "Castle kingside: move your king two squares to the right.",
        fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", goal: { type: "move", moves: ["e1g1"] } },
      { text: "Castle queenside: move your king two squares to the left.",
        fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", goal: { type: "move", moves: ["e1c1"] } },
      { text: "En passant: when a pawn advances two squares and lands right beside your pawn, you may capture it as if it had moved only one square, but only on the very next move.",
        fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", goal: { type: "info" } },
      { text: "Black just played d7-d5. Capture it en passant!",
        fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", goal: { type: "move", moves: ["e5d6"] } },
    ],
  },
  {
    id: "forks", title: "Forks", category: "Tactics",
    steps: [
      { text: "A fork is one piece attacking two (or more) enemy pieces at the same time. Your opponent can only save one of them.",
        fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Find the knight move that checks the king and attacks the rook at the same time.",
        fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["b5c7"] } },
      { text: "The king had to move. Collect the rook!",
        fen: "r7/2N1k3/8/8/8/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "a8" } },
      { text: "Queens fork too. Find the queen check that also attacks the rook in the corner.",
        fen: "r5k1/6pp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", goal: { type: "move", moves: ["d1d5"] } },
      { text: "Even a humble pawn can fork. Push a pawn to attack both the knight and the bishop.",
        fen: "4k3/8/8/2n1b3/8/4P3/3P4/4K3 w - - 0 1", goal: { type: "move", moves: ["d2d4"] } },
    ],
  },
  {
    id: "pins", title: "Pins", category: "Tactics",
    steps: [
      { text: "A pin attacks a piece that can't move out of the way without exposing a more valuable piece behind it. If that piece is the king, the pinned piece can't legally move at all.",
        fen: "4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1", goal: { type: "info" } },
      { text: "Pin the knight to the black king with your bishop.",
        fen: "4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1", goal: { type: "move", moves: ["f1b5"] } },
      { text: "The pinned knight can't move, not even to capture your pawn. Attack it with the pawn to win it.",
        fen: "4k3/8/2n5/1B6/3P4/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["d4d5"] } },
      { text: "Pin the black queen to its king. Your b3 pawn keeps the bishop protected, so the queen can't simply take it.",
        fen: "6k1/6pp/8/3q4/8/1P6/P3BPPP/6K1 w - - 0 1", goal: { type: "move", moves: ["e2c4"] } },
    ],
  },
  {
    id: "skewers", title: "Skewers", category: "Tactics",
    steps: [
      { text: "A skewer is a pin in reverse: you attack a valuable piece, and when it moves away, you capture the piece standing behind it.",
        fen: "3q4/8/8/3k4/8/8/8/R5K1 w - - 0 1", goal: { type: "info" } },
      { text: "Check the king along the d-file. When it moves, the queen behind it falls.",
        fen: "3q4/8/8/3k4/8/8/8/R5K1 w - - 0 1", goal: { type: "move", moves: ["a1d1"] } },
      { text: "Skewer the king and rook along the long diagonal with your bishop.",
        fen: "r7/8/2k5/8/8/8/8/1B4K1 w - - 0 1", goal: { type: "move", moves: ["b1e4"] } },
      { text: "The king stepped aside. Capture the rook!",
        fen: "r7/8/3k4/8/4B3/8/8/6K1 w - - 0 1", goal: { type: "capture", square: "a8" } },
    ],
  },
  {
    id: "back-rank", title: "Back-Rank Mate", category: "Tactics",
    steps: [
      { text: "A king hiding behind its own unmoved pawns can be mated by a rook or queen on the back rank, because the pawns block every escape.",
        fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1", goal: { type: "info" } },
      { text: "Deliver a back-rank mate with your rook.",
        fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1", goal: { type: "mate" } },
      { text: "The same idea works with the queen. Checkmate!",
        fen: "6k1/5ppp/8/8/8/8/1Q3PPP/6K1 w - - 0 1", goal: { type: "mate" } },
      { text: "Now it's your back rank in danger: Black threatens ...Re1 mate. Push a pawn in front of your king to give it an escape square (called 'luft').",
        fen: "4r1k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1", goal: { type: "move", moves: ["h2h3", "h2h4", "g2g3", "g2g4", "f2f3", "f2f4"] } },
    ],
  },
  {
    id: "opening-principles", title: "Opening Principles", category: "Strategy",
    steps: [
      { text: "Three goals in the opening: control the center, develop your knights and bishops, and castle your king to safety.",
        fen: START, goal: { type: "info" } },
      { text: "Grab a share of the center with a pawn: play e4 or d4.",
        fen: START, goal: { type: "move", moves: ["e2e4", "d2d4"] } },
      { text: "Develop a knight toward the center, where it controls the most squares.",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", goal: { type: "move", moves: ["g1f3", "b1c3"] } },
      { text: "Bring out your light-squared bishop to an active square so you can castle.",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", goal: { type: "move", moves: ["f1c4", "f1b5"] } },
      { text: "Castle kingside to tuck your king away and connect your rooks.",
        fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", goal: { type: "move", moves: ["e1g1"] } },
      { text: "Rules of thumb: don't move the same piece twice without a reason, don't bring the queen out too early, and don't grab pawns while your pieces are still at home.",
        fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 5", goal: { type: "info" } },
    ],
  },
  {
    id: "basic-checkmates", title: "Checkmate with the Queen", category: "Endgames",
    steps: [
      { text: "With king and queen against a lone king, use the queen to push the king to the edge, then bring your own king close to help deliver mate.",
        fen: "8/8/8/4k3/8/8/8/3QK3 w - - 0 1", goal: { type: "info" } },
      { text: "The black king is trapped on the edge. Mate it in one move.",
        fen: "k7/8/1K6/8/8/8/8/6Q1 w - - 0 1", goal: { type: "mate" } },
      { text: "Mate in one again, but be careful: one queen move here is stalemate!",
        fen: "k7/2K5/8/8/8/8/8/1Q6 w - - 0 1", goal: { type: "mate" } },
    ],
  },
];
