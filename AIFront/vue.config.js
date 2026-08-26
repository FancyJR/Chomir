module.exports = {
  devServer: {
    port: 8080,
    open: true,
    compress: false,
    historyApiFallback: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  }
}

