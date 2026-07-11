export type CollisionPoint = { x: number; y: number };

const MOTION_EPSILON = 1e-9;

export function collisionPairKey(firstId: string, secondId: string) {
  return firstId < secondId ? `${firstId}\u0000${secondId}` : `${secondId}\u0000${firstId}`;
}

export function hasSweptCircleContact(
  previousA: CollisionPoint,
  currentA: CollisionPoint,
  previousB: CollisionPoint,
  currentB: CollisionPoint,
  radiusA: number,
  radiusB = radiusA
) {
  const relativeStartX = previousA.x - previousB.x;
  const relativeStartY = previousA.y - previousB.y;
  const relativeDeltaX = (currentA.x - previousA.x) - (currentB.x - previousB.x);
  const relativeDeltaY = (currentA.y - previousA.y) - (currentB.y - previousB.y);
  const relativeMotionSquared = relativeDeltaX ** 2 + relativeDeltaY ** 2;
  const approach = relativeStartX * relativeDeltaX + relativeStartY * relativeDeltaY;
  if (relativeMotionSquared <= MOTION_EPSILON || approach >= -MOTION_EPSILON) return false;

  const closestTime = Math.min(1, Math.max(0, -approach / relativeMotionSquared));
  const closestX = relativeStartX + relativeDeltaX * closestTime;
  const closestY = relativeStartY + relativeDeltaY * closestTime;
  const combinedRadius = radiusA + radiusB;
  return closestX ** 2 + closestY ** 2 <= combinedRadius ** 2;
}

export function isAngularlyApproaching(
  previousAngleA: number,
  currentAngleA: number,
  previousAngleB: number,
  currentAngleB: number
) {
  const rawGap = previousAngleB - previousAngleA;
  const previousGap = Math.atan2(Math.sin(rawGap), Math.cos(rawGap));
  const relativeDelta = (currentAngleB - previousAngleB) - (currentAngleA - previousAngleA);
  return Math.abs(relativeDelta) > MOTION_EPSILON && previousGap * relativeDelta < -MOTION_EPSILON;
}
