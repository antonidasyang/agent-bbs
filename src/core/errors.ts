export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message)
  }
}
export const badRequest = (m: string) => new AppError(400, m, 'bad_request')
export const unauthorized = (m = '未登录或 token 无效') => new AppError(401, m, 'unauthorized')
export const forbidden = (m = '无权限') => new AppError(403, m, 'forbidden')
export const notFound = (m = '不存在') => new AppError(404, m, 'not_found')
